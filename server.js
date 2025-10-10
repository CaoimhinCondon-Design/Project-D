// server.js

import express from "express";
import cors from "cors";
import { OpenAI } from "openai";

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const OPENAI_MODEL_ANSWER = process.env.OPENAI_MODEL_ANSWER || "gpt-4o-mini";
const OPENAI_MODEL_SUMMARY = process.env.OPENAI_MODEL_SUMMARY || "gpt-4o-mini";
const OPENAI_MODEL_TRANSCRIBE = process.env.OPENAI_MODEL_TRANSCRIBE || "gpt-4o-transcribe"; // or "whisper-1"
const OPENAI_MODEL_TTS = process.env.OPENAI_MODEL_TTS || "gpt-4o-mini-tts";
const MAX_CONCURRENT_PARAGRAPH_JOBS = Number(process.env.MAX_PAR_JOBS || 3);

// ---------- OpenAI client ----------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ---------- Express ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" })); // audio can be large

// ---------- Small helpers ----------
function b64ToBuffer(b64) {
  // Accepts "data:audio/...;base64,AAAA" or bare base64
  const clean = (b64 || "").split(",").pop() || "";
  return Buffer.from(clean, "base64");
}

function dataUrlFromBase64(base64, mime = "audio/mp3") {
  return `data:${mime};base64,${base64}`;
}

function sendSSEEvent(res, event, payload) {
  // NOTE: keep it resilient to non-JSON payloads
  const data = typeof payload === "string" ? payload : JSON.stringify(payload);
  res.write(`event: ${event}\n`);
  res.write(`data: ${data}\n\n`);
}

function sseHeaders() {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // For some proxies, you can also add:
    // "X-Accel-Buffering": "no"
  };
}

// Simple async semaphore without dependencies
function limiter(max) {
  let running = 0;
  const queue = [];
  const runNext = () => {
    if (running >= max || queue.length === 0) return;
    const { fn, resolve, reject } = queue.shift();
    running++;
    fn()
      .then((v) => {
        running--;
        resolve(v);
        runNext();
      })
      .catch((e) => {
        running--;
        reject(e);
        runNext();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      runNext();
    });
}

const limit = limiter(MAX_CONCURRENT_PARAGRAPH_JOBS);

// ---------- Core tasks (Transcribe / Answer / Summary / TTS) ----------
async function transcribeAudioBuffer(buf) {
  // Prefer OpenAI speech-to-text. If using "whisper-1", pass as a file.
  // With gpt-4o-transcribe, you can pass the buffer directly as audio input via Responses.
  try {
    // Use Responses API for transcription if model supports it:
    const resp = await openai.audio.transcriptions.create({
      file: new File([buf], "audio.webm", { type: "audio/webm" }),
      model: OPENAI_MODEL_TRANSCRIBE,
      // temperature, language, etc. are optional
    });
    return resp.text || "";
  } catch (err) {
    // Fallback to Whisper if configured differently or SDK mismatch
    // Re-throw; top-level will catch and report.
    throw err;
  }
}

async function streamAnswerSSE({ res, systemPrompt, userText, onToken, onDone, signal }) {
  // Stream the model’s answer token-by-token to SSE.
  // Uses Responses Streaming API (SDK v4). Adjust if you use a different SDK version.
  const stream = await openai.responses.stream({
    model: OPENAI_MODEL_ANSWER,
    input: [
      { role: "system", content: systemPrompt || "You are a helpful assistant." },
      { role: "user", content: userText },
    ],
    temperature: 0.7,
  });

  let fullText = "";

  stream.on("content.delta", (delta, _snapshot) => {
    // delta is a string chunk
    const token = String(delta || "");
    fullText += token;
    try {
      onToken?.({ token, text: fullText, done: false });
    } catch {
      // Never let UI callback kill the stream
    }
  });

  stream.on("content.done", () => {
    try {
      onToken?.({ token: "", text: fullText, done: true });
    } catch {}
  });

  stream.on("message", () => {
    // no-op; already handled in content events
  });

  stream.on("end", () => {
    onDone?.(fullText);
  });

  stream.on("error", (err) => {
    throw err;
  });

  if (signal) {
    signal.addEventListener("abort", () => {
      try {
        stream.controller.abort();
      } catch {}
    });
  }

  await stream.finalMessage(); // wait for completion
  return fullText;
}

async function summarizeParagraph(p) {
  const prompt = `Write a *single-sentence* summary of the following paragraph in plain English (<=25 words):\n\n${p}`;
  const r = await openai.responses.create({
    model: OPENAI_MODEL_SUMMARY,
    input: [{ role: "user", content: prompt }],
    temperature: 0.3,
  });
  const content = r.output_text || "";
  return content.trim();
}

async function ttsForParagraph(text) {
  // Return a data URL (base64) for quick playback on the client
  const speech = await openai.audio.speech.create({
    model: OPENAI_MODEL_TTS,
    input: text,
    voice: "alloy", // change to your preferred voice
    format: "mp3",
  });

  const base64 = Buffer.from(await speech.arrayBuffer()).toString("base64");
  return dataUrlFromBase64(base64, "audio/mpeg");
}

// Safe paragraph workflow wrapper
async function workflowSafe({ paragraph, index, res }) {
  try {
    const [shortSummary, ttsDataUrl] = await Promise.all([
      summarizeParagraph(paragraph),
      ttsForParagraph(paragraph),
    ]);
    sendSSEEvent(res, "finishedParagraph", { ttsDataUrl, shortSummary, index });
    return { ok: true, index };
  } catch (err) {
    sendSSEEvent(res, "subStatus", { stage: `paragraph ${index} failed` });
    return { ok: false, index, error: String(err?.message || err) };
  }
}

// ---------- Routes ----------

// JSON fallback (non-streaming): /api/message
app.post("/api/message", async (req, res) => {
  try {
    const { audioBase64 } = req.body || {};
    if (!audioBase64) return res.status(400).json({ error: "audioBase64 required" });

    // 1) Transcribe
    const audioBuf = b64ToBuffer(audioBase64);
    const transcript = await transcribeAudioBuffer(audioBuf);

    // 2) Answer (non-stream)
    const r = await openai.responses.create({
      model: OPENAI_MODEL_ANSWER,
      input: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: transcript },
      ],
      temperature: 0.7,
    });

    const answer = r.output_text || "";

    // 3) TTS for the full answer
    const speech = await openai.audio.speech.create({
      model: OPENAI_MODEL_TTS,
      input: answer,
      voice: "alloy",
      format: "mp3",
    });
    const ttsBase64 = Buffer.from(await speech.arrayBuffer()).toString("base64");
    const ttsDataUrl = dataUrlFromBase64(ttsBase64, "audio/mpeg");

    return res.json({ transcript, answer, ttsDataUrl });
  } catch (err) {
    console.error("POST /api/message error:", err);
    return res.status(500).json({ error: "Internal error." });
  }
});

// SSE streaming: /api/message/stream
app.post("/api/message/stream", async (req, res) => {
  // SSE setup
  res.writeHead(200, sseHeaders());

  const abort = new AbortController();
  const { signal } = abort;

  // Periodic keep-alive (helps some proxies)
  const ka = setInterval(() => {
    res.write(": keep-alive\n\n");
  }, 15000);

  const safeClose = (code = 200, reason = "ok") => {
    clearInterval(ka);
    try {
      sendSSEEvent(res, "subStatus", { stage: "done" });
      sendSSEEvent(res, "done", { code, reason });
    } catch {}
    try {
      res.end();
    } catch {}
  };

  try {
    const { audioBase64 } = req.body || {};
    if (!audioBase64) {
      sendSSEEvent(res, "error", { message: "audioBase64 required" });
      return safeClose(400, "no-audio");
    }

    // 1) Transcribe
    sendSSEEvent(res, "subStatus", { stage: "transcribing" });
    const audioBuf = b64ToBuffer(audioBase64);
    const transcript = await transcribeAudioBuffer(audioBuf);
    // You can stream transcript text if you want; here we send once:
    sendSSEEvent(res, "transcript", transcript);

    // 2) Reasoning / Answer (token stream)
    sendSSEEvent(res, "subStatus", { stage: "reasoning" });

    let paragraphs = [];
    let currentIndex = 0;
    const paragraphJobs = []; // array of promises (we attach catch immediately)
    let streamedAnswer = "";

    // onToken: fire paragraph jobs when a newline *boundary* is crossed
    const onToken = async ({ token, text, done }) => {
      try {
        if (signal.aborted) return;
        if (typeof token === "string" && token.length) {
          sendSSEEvent(res, "token", { token, text });
        }

        const safeText = typeof text === "string" ? text : "";
        paragraphs = safeText.split(/\n/);

        // fire jobs for any fully-formed paragraphs we haven't processed yet
        while (paragraphs.length - 1 > currentIndex) {
          const p = (paragraphs[currentIndex] ?? "").trim();
          if (p) {
            // Throttle & catch immediately to avoid unhandled rejections
            const job = limit(() => workflowSafe({ paragraph: p, index: currentIndex, res }))
              .catch((err) => ({ ok: false, index: currentIndex, error: String(err) }));
            paragraphJobs.push(job);
          }
          currentIndex++;
        }

        if (done) {
          // Handle potential leftover last paragraph
          const last = paragraphs.at(-1);
          const p = typeof last === "string" ? last.trim() : "";
          if (p) {
            const job = limit(() => workflowSafe({ paragraph: p, index: currentIndex, res }))
              .catch((err) => ({ ok: false, index: currentIndex, error: String(err) }));
            paragraphJobs.push(job);
          }

          streamedAnswer = safeText.trim();
          sendSSEEvent(res, "answer", { answer: streamedAnswer });

          sendSSEEvent(res, "subStatus", { stage: "summarizing & speaking" });
          // Wait for all paragraph jobs to settle (no throw)
          const results = await Promise.allSettled(paragraphJobs);
          // (Optional) you can emit results for debugging
          // sendSSEEvent(res, "debug", { results });
        }
      } catch (err) {
        // Never let a single bad tick kill the stream
        sendSSEEvent(res, "subStatus", { stage: "stream handler error" });
      }
    };

    const onDone = (finalText) => {
      // no-op here; we already sent "answer" above in onToken(done)
    };

    const systemPrompt = "You are a helpful assistant. Answer clearly and concisely.";
    await streamAnswerSSE({
      res,
      systemPrompt,
      userText: transcript,
      onToken,
      onDone,
      signal,
    });

    safeClose();
  } catch (err) {
    console.error("POST /api/message/stream error:", err);
    try {
      sendSSEEvent(res, "error", { message: err?.message || "Internal error." });
    } catch {}
    safeClose(500, "error");
  }
});

// ---------- Startup ----------
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

// ---------- Global hardening ----------
// Prevent the process from dying on unhandled promise rejections.
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});
