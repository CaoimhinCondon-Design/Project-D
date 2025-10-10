import express from "express";
import dotenv from "dotenv";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));
app.use(express.json({ limit: "25mb" })); // for base64 JSON payloads

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
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      stream: true,
      messages: [
        { role: "system", content: "You are concise and helpful." },
        { role: "user", content: prompt }
      ]
    })
  });
  if (!r.ok) throw new Error(await r.text());

  const reader = r.body?.getReader();
  if (!reader) throw new Error("Streaming not supported in this runtime.");

  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullText = "";
  const safeOnToken = typeof onToken === "function" ? onToken : null;
  let streamClosed = false;

  const extractContent = (delta) => {
    if (!delta) return "";
    if (typeof delta.content === "string") return delta.content;
    if (Array.isArray(delta.content)) {
      return delta.content
        .map((part) => {
          if (!part) return "";
          if (typeof part === "string") return part;
          if (typeof part.text === "string") return part.text;
          if (typeof part.content === "string") return part.content;
          return "";
        })
        .join("");
    }
    return "";
  };

  while (!streamClosed) {
    const { value, done } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: true });
    }
    if (done) {
      buffer += decoder.decode(new Uint8Array(), { stream: false });
      streamClosed = true;
    }

    buffer = buffer.replace(/\r\n/g, "\n");
    let delimiterIndex;
    while ((delimiterIndex = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, delimiterIndex);
      buffer = buffer.slice(delimiterIndex + 2);

      const dataLines = rawEvent
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter(Boolean);

      for (const dataLine of dataLines) {
        if (dataLine === "[DONE]") {
          streamClosed = true;
          break;
        }
        let payload;
        try {
          payload = JSON.parse(dataLine);
        } catch {
          continue;
        }
        const delta = payload.choices?.[0]?.delta;
        const token = extractContent(delta);
        if (!token) continue;
        fullText += token;
        if (safeOnToken) {
          await safeOnToken({ token, text: fullText });
        }
      }
      if (streamClosed) break;
    }
  }

  if (safeOnToken) {
    await safeOnToken({ done: true, text: fullText });
  }

  return fullText.trim();
}

// Helper: summarize (short) for speaking
async function summarizeForSpeech(text) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages: [
        { role: "system", content: "Summarize in <= 2 short sentences for speaking." },
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
  const { audioBase64 } = req.body;
  if (!audioBase64) return res.status(400).json({ error: "audioBase64 required" });

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const sendEvent = (event, payload) => {
    const trimedEvent = event.trim();
    res.write(`event: ${trimedEvent}\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  async function workflow(paragraph, index){
    if (streamClosed) return;
    sendEvent("subStatus", { stage: `working on paragraph ${index}` });
    const shortSummary = await summarizeForSpeech(paragraph);
    const ttsDataUrl = await speakWithTTS(shortSummary);
    sendEvent("finishedParagraph", {ttsDataUrl, shortSummary, index});
    return {ttsDataUrl, shortSummary, index}
}

  const controller = new AbortController();
  const { signal } = controller;
  let streamClosed = false;
  req.on("close", () => {
    streamClosed = true;
    controller.abort();
    res.end();
  });

  try {
    sendEvent("status", { stage: "transcribing" });
    const transcript = await transcribeWebmBase64(audioBase64);
    sendEvent("transcript", { transcript });

    sendEvent("status", { stage: "reasoning" });
    let streamedAnswer = "";
    let paragraphs = [];
    let workloadPromises = {};
    let currentIndex = 0;
    await streamAnswer(transcript, {
      signal,
      onToken: async ({ token, text, done }) => {
        if (streamClosed) return;
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
        } else if (token) {
          sendEvent("token", { token, text });
        }
      }
    });

    //sendEvent("status", { stage: "summarizing" });
    //const shortSummary = await summarizeForSpeech(streamedAnswer);
    //sendEvent("summary", { shortSummary });

    //sendEvent("status", { stage: "speaking" });
    //const ttsDataUrl = await speakWithTTS(shortSummary);
    //sendEvent("speech", { ttsDataUrl });

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