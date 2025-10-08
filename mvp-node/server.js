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

app.listen(PORT, () => {
  console.log(`MVP running: http://localhost:${PORT}`);
});

/* ------------------------
   OPTIONAL: Realtime version for speaking via gpt-realtime-mini
   (collects audio from the Realtime WebSocket and returns a data URL)
   This is a minimal sketch; check the Realtime docs for the event schema.
-------------------------*/
import WebSocket from "ws";

async function speakWithRealtime(summaryText) {
  const model = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-mini";
  const voice = process.env.OPENAI_REALTIME_VOICE || "verse";

  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}&voice=${encodeURIComponent(voice)}`, {
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    });

    const audioChunks = []; // will collect base64 audio frames
    ws.on("open", () => {
      // Ask the model to speak our summary
      ws.send(JSON.stringify({
        type: "response.create",
        response: {
          instructions: "Speak the following summary clearly and naturally.",
          modalities: ["audio"],
          input_text: summaryText
        }
      }));
    });

    ws.on("message", (msg) => {
      try {
        const evt = JSON.parse(msg.toString());
        // Depending on the snapshot, audio can come as delta chunks:
        // e.g., evt.type === "response.output_audio.delta" with evt.delta (base64)
        if (evt.type === "response.output_audio.delta" && evt.delta) {
          audioChunks.push(evt.delta);
        }
        if (evt.type === "response.completed") {
          ws.close();
          // Join base64 chunks; Realtime typically streams PCM/Opus depending on settings.
          const b64 = audioChunks.join("");
          // Many snapshots stream raw PCM — wrapping to WAV is ideal.
          // For brevity we return as "audio/wav" data URL; adjust per model/codec if needed.
          resolve(`data:audio/wav;base64,${b64}`);
        }
        if (evt.type === "error") {
          reject(new Error(evt.error || "realtime_error"));
        }
      } catch (e) {
        // Some frames may be binary (ignore); or use ws binary handler if needed.
      }
    });

    ws.on("error", reject);
  });
}
