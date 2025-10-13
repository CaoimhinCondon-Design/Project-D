import express from "express";
import dotenv from "dotenv";
import { OpenAI } from "openai";
dotenv.config();
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));
app.use(express.json({ limit: "25mb" })); // for base64 JSON payloads

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper: call OpenAI Audio->Transcriptions (Whisper)
async function transcribeWebmBase64(audioBase64) {
  const buf = Buffer.from(audioBase64, "base64");
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "audio/webm" }), "audio.webm");
  form.append("model", "whisper-1"); // STT model
  // You can set language hints: form.append("language", "en");

  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form
  });
  if (!r.ok) throw new Error(await r.text());
  const json = await r.json();
  return json.text || "";
}

// Helper: call GPT for reasoning
async function completeAnswer(prompt) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: "You are concise and helpful." },
        { role: "user", content: prompt }
      ]
    })
  });
  if (!r.ok) throw new Error(await r.text());
  const j = await r.json();
  return j.choices?.[0]?.message?.content?.trim() ?? "";
}

// Helper: call GPT for reasoning with streamed tokens
async function streamAnswer(prompt, { onToken, signal } = {}) {
const SYSTEM_PROMPT = `
You are a helpful assistant that writes in full Markdown.

STYLE
- Use headings, bullet lists, tables, links when helpful.
- Use code fences for code: \`\`\`lang ...\`\`\`, preceded by a 1–2 line explanation.
- Use LaTeX: inline ($x^2$) and display ($$...$$).
- Write in short paragraphs separated by a BLANK LINE.
- When you finish a paragraph, END IT CLEANLY and then insert ONE blank line, so it’s clearly separable in a stream.

CONTENT
- Give final answers and brief justifications; do not reveal hidden chain-of-thought.
- Mirror the user’s language.
- If unsafe, refuse briefly and suggest a safe alternative.
`;


  const safeOnToken = typeof onToken === "function" ? onToken : null;
  let streamClosed = false;
  let fullText = "";
  let token;

  const stream = await client.responses.create({
    model: "gpt-4o-mini",
    input: [
        {
            role: "system",
            content: SYSTEM_PROMPT,
        },
        {
            role: "user",
            content: prompt,
        },
    ],
    temperature: 0.2,
    stream: true,
    signal,
});

for await (const event of stream) {
    if (event.type === 'response.output_text.delta'){
        token = event.delta;
        if (!token) continue;
        fullText += token;
        if (safeOnToken) {
          await safeOnToken({ token, text: fullText });
        }
    }
    if (streamClosed) break;
}

if (safeOnToken) {
    await safeOnToken({ done: true, text: fullText });
  }

  console.log(fullText)
  return fullText.trim();
}

// Helper: summarize (short) for speaking
async function summarizeForSpeech(text, signal) {
  const SYSTEM_PROMPT = `
You produce a brief, natural, spoken-style summary of ONE paragraph at a time.

REQUIREMENTS
- Mirror the user's language and the conversation tone.
- 1–2 sentences, ≤ 35 words total.
- Conversational and easy to speak aloud.
- No lists, no code, no Markdown; just the line to be spoken.

CONTEXT
- You may be given prior conversation turns; favor consistent wording, names, and terms used earlier in this conversation.

OUTPUT
- Return only the short summary text (no labels).
`;

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    signal,
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text }
      ]
    })
  });
  if (!r.ok) throw new Error(await r.text());
  const j = await r.json();
  return j.choices?.[0]?.message?.content?.trim() ?? "";
}

// Helper: speak summary using OpenAI Audio->Speech (HTTP, simple)
async function speakWithTTS(summaryText) {
  // Models compatible: gpt-4o-mini-tts, tts-1, tts-1-hd
  const r = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: "alloy",           // pick one of the built-in voices
      input: summaryText        // text to speak
    })
  });
  if (!r.ok) throw new Error(await r.text());
  const arrayBuf = await r.arrayBuffer();
  const b64 = Buffer.from(arrayBuf).toString("base64");
  // Return as a data URL (short clips only)
  return `data:audio/mpeg;base64,${b64}`;
}

/**
 * POST /api/message
 * { audioBase64: <base64 webm/opus> }
 */
app.post("/api/message", async (req, res) => {
  try {
    const { audioBase64 } = req.body;
    if (!audioBase64) return res.status(400).json({ error: "audioBase64 required" });

    // 1) STT (Whisper)
    const transcript = await transcribeWebmBase64(audioBase64);

    // 2) Reasoning (GPT)
    const answer = await completeAnswer(transcript);

    // 3) Summarize + speak (OpenAI TTS - simplest path)
    const shortSummary = await summarizeForSpeech(answer);
    const ttsDataUrl = await speakWithTTS(shortSummary);

    res.json({ transcript, answer, shortSummary, ttsDataUrl });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "processing_failed" });
  }
});

/**
 * POST /api/message/stream
 * Streams GPT tokens (SSE) while preserving the existing processing pipeline.
 */
app.post("/api/message/stream", async (req, res) => {
  console.log("using stream post")
  const { audioBase64 } = req.body;
  if (!audioBase64) return res.status(400).json({ error: "audioBase64 required" });

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // respected by nginx & some PaaS
  res.flushHeaders?.();

  const sendEvent = (event, payload) => {
    const trimedEvent = event.trim();
    let info = ""
    if (trimedEvent == "status" && payload.stage){
      info = payload.stage
    }
    //console.log("Sent Event: " + event + " " + info)
    res.write(`event: ${trimedEvent}\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  async function heartBeat(signal) {
    while (signal) {
      sendEvent("Heartbeat", {})
      await wait(1000)
    }
  }

  async function workflow(paragraph, index, signal){
    //if (streamClosed) return;
    sendEvent("subStatus", { stage: `working on paragraph ${index}` });
    const shortSummary = await summarizeForSpeech(paragraph, signal);
    const ttsDataUrl = await speakWithTTS(shortSummary);
    sendEvent("finishedParagraph", {ttsDataUrl, shortSummary, index});
    return {ttsDataUrl, shortSummary, index}
}

  const controller = new AbortController();
  const { signal } = controller;
  let streamClosed = false;
  heartBeat(signal)
  req.on("close", () => {
    console.log("req closed: StreamClosed")
    streamClosed = true;
    controller.abort();
    res.end();
  });

  try {
    sendEvent("status", { stage: "transcribing" });
    const transcript = await transcribeWebmBase64(audioBase64);
    sendEvent("transcript", { transcript });
    console.log(transcript)

    sendEvent("status", { stage: "reasoning" });
    let streamedAnswer = "";
    let paragraphs = [];
    let workloadPromises = {};
    let currentIndex = 0;
    await streamAnswer(transcript, {
      signal,
      onToken: async ({ token, text, done }) => {
        //console.log("running onToken");
        //if (streamClosed) return;
        //console.log("still running");
        paragraphs = text.split(/\n/);
        while (paragraphs.length-1 > currentIndex) { // -1 because we dont want to start work on the last item in the array as it may be an imcomplete paragraph 
          const p = paragraphs[currentIndex].trim();
          if (p) {
            workloadPromises[currentIndex] = workflow(p, currentIndex);
          }
          currentIndex++;
        }
        if (done) {
          const p = paragraphs.at(-1).trim();
          if (p) {
            workloadPromises[currentIndex] = workflow(p, currentIndex);
          }
          streamedAnswer = text?.trim() ?? "";
          sendEvent("answer", { answer: streamedAnswer });
          const results = await Promise.allSettled(Object.values(workloadPromises));
          console.log("\n\n\n\n\n\n results \n\n")
          for (const result of results) {
            //console.log(result)
          }
        } else if (token) {
          sendEvent("token", { token, text });
        }
      }
    });

    // sendEvent("done", {
    //   transcript,
    //   answer: streamedAnswer,
    //   shortSummary,
    //   ttsDataUrl
    // });

    if (!streamClosed) res.end();
  } catch (e) {
    if (!streamClosed) {
      console.error(e);
      sendEvent("error", { message: "processing_failed" });
      res.end();
    }
  }
});

app.listen(PORT, () => {
  console.log(`MVP running: http://localhost:${PORT}`);
});