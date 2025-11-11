import express from "express";
import dotenv from "dotenv";
import { OpenAI } from "openai";
import { PrismaClient } from "@prisma/client";
// import cookieParser from "cookie-parser";
import crypto from "crypto";

dotenv.config();
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cookieParser());
app.use(express.static("public"));
app.use(express.json({ limit: "25mb" })); // for base64 JSON payloads

let chats = {};

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==============================
// Database Helpers
// ==============================

async function getOrCreateAnotherUser(req, res) {

  let anonId = req.cookies.anonId;

  if (!anonId) {

    anonId = crypto.randomUUID
      
    // Set a long-lived cookie
    res.cookie("anonID", anonId, {

      httpOnly: true,
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24 * 365, // 1 year
    });
  }

  const anonEmail = 'anon_${anonId}@placeholder.local'

  const user = await prisma.user.upsert({

    where: { email: anonEmail},
    update: {},
    create: {
      email: anonEmail,
      passwordHash: "ANON", // This is just a place holder, real auth will ignore this 
    },
  });

  return user;
}

// Simple health check to make sure db connection is good
app.get("/health/db", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false });
  }
});

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

const Reasoning_SYSTEM_PROMPT = `
You are a helpful assistant that writes in full Markdown always. As you write in Markdown you include chunks as detailed below. Make it nicly formated with titles ect
The end user can't see the chunking marks so include them freely

STYLE
- Use headings, bullet lists, tables, and links when helpful.
- Use code fences for code: \`\`\`lang ...\`\`\`, preceded by a 1-2 line explanation.
- Use LaTeX: inline ($x^2$) and display ($$...$$).

CHUNKING FOR SUMMARY
- Wrap every summary-worthy unit in explicit markers so another model can segment it:
  - Start each chunk with "<開>"
  - End each chunk with "<閉>"
- Each *logical unit* must be its own chunk. Do not nest or overlap chunks.
- A whole subsection under a header may be a single chunk or split into multiple chunks, at your discretion.
- Chunks should be long enough to contain meaningful information to summarize; avoid overly short fragments.
- Chunks should be longer then 10 words but never exceed 100 words. (IMPORTANT!!!)
- Include full code blocks and LaTeX inside the chunk markers.
- Do not emit stray "<開>" or "<閉>": every "<開>" must have a matching "<閉>".
- Everything you write must belong to a chunk !!!!
- Start all responces with <開> the open chunk token followed by the big title

CONTENT
- Give final answers and brief justifications; do not reveal hidden chain-of-thought.
- Mirror the user's language.
- If unsafe, refuse briefly and suggest a safe alternative.
`;

// Helper: call GPT for reasoning with streamed tokens
async function streamAnswer(chatID, { onToken, signal } = {}) {

  const safeOnToken = typeof onToken === "function" ? onToken : null;
  let streamClosed = false;
  let fullText = "";
  let token;

  const stream = await client.responses.create({
    model: "gpt-4o-mini",
    input: chats[chatID][0],
    temperature: 0.2,
    stream: true,
},  { signal });

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

const SUMMERY_SYSTEM_PROMPT = `
REQUIREMENTS
Mirror the user's tone and language style naturally.
Responses should be 1-2 sentences, under 35 words total.
Keep it conversational and easy to say aloud.
Avoid lists, code formatting, or Markdown. DO NOT USE LATEX. Everything should be formatted so it can be read verbatim by TTS.
Never repeat details the assistant already mentioned.
Vary rhythm and phrasing so each line feels fresh and flows from the previous one, as if part of a natural conversation.
Never start a sentence with the same word each time.
If a summary is very short (under 12 words), randomly begin or include natural filler like 'am', 'uhh', or 'hmm' to make it sound spontaneous.

CONTEXT
You receive one chunk per turn (from another AI) and return its summary immediately. New chunks arrive in later turns; your summaries appear between them.
If a chunk is a title/header/intro line, return a minimal 3-4 word placeholder instead of summarizing it.
If a chunk has no content worth summarizing (e.g., just $$, whitespace, or it is a section with nothing meaningful to summarize), return the single character '無'.

OUTPUT
Return only the short spoken-style summary text for the current chunk.
`;


function newChat(){
  const now = new Date();
  const chatID = Math.floor(Math.random() * 1000000000000000).toString();
  chats[chatID] = {};
  chats[chatID][0] = [
    { role: "system", content: Reasoning_SYSTEM_PROMPT },
  ];
  chats[chatID][1] = [
    { role: "system", content: SUMMERY_SYSTEM_PROMPT },
  ];
  chats[chatID].reasoningBuffer = "";
  return chatID;
}

// Helper: summarize (short) for speaking
async function summarizeForSpeech(text, chatID, signal) {
  chats[chatID][1].push({ role: "user", content: `PARAGRAPH:\n${text}`})

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
      messages: chats[chatID][1]
    })
  });
  if (!r.ok) throw new Error(await r.text());
  const j = await r.json();
  const output = j.choices?.[0]?.message?.content?.trim() ?? "";
  chats[chatID][1].push({ role: "assistant", content: output})
    if (output.trim() === "無"){
    return ""
  }
  return output;
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
 * Event handling
 */
const EVENT_BUFFER_LIMIT = 500; // tune as needed
const sseState = {
  // [chatID]: { nextId: number, buffer: Array<{id,event,data,ts}> }
};

function getSseState(chatID) {
  if (!sseState[chatID]) {
    sseState[chatID] = { nextId: 1, buffer: [] };
  }
  return sseState[chatID];
}

function pushToBuffer(chatID, msg) {
  const state = getSseState(chatID);
  state.buffer.push(msg);
  if (state.buffer.length > EVENT_BUFFER_LIMIT) state.buffer.shift();
}

function writeSse(res, { id, event, data }) {
  // Optional reconnection hint:
  res.write(`retry: 1000\n`);
  res.write(`id: ${id}\n`);
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}




/**
 * get and POST /api/message/stream
 */
app.get("/api/new_chat", async (_req, res) => {
  
  try{
    
    const user = await getOrCreateAnotherUser(_req, res);

    const chatID = newChat();

    await prisma.chat.create({
      data: {
        id: chatID, // Reuse the existing chat ID
        userID: user.id,
        title: null,
      }
    });

    res.json({chatID});
  }
  catch (e){
    console.error(e);
    res.status(500).json({ error: "new_chat_creation_failed" });
  }
});

app.get('/data', (req, res) => {
  const { chatID } = req.query;
  if (!chatID) {
    res.status(400).json({ error: "chatID required" });
    return;
  }

  const reasoning = chats[chatID][0]
  const summery = chats[chatID][1]

  res.json({ reasoning, summery });
})

app.post("/api/message/stream", async (req, res) => {
  try {
    const { audioBase64, chatID } = req.body;
    if (!audioBase64) return res.status(400).json({ error: "audioBase64 required" });
    if (!chatID) return res.status(400).json({ error: "chatID required" });

    // 1) STT (Whisper)
    const transcript = await transcribeWebmBase64(audioBase64);
    chats[chatID][0].push({ role: "user", content: transcript});
    chats[chatID][1].push({ role: "user", content: `Users original question was:\n${transcript}`});

    res.json({transcript});
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "processing_failed" });
  }
})

app.post("/api/message/raw_text", async (req, res) => {
  try {
    const { text, chatID } = req.body;
    if (!text) return res.status(400).json({ error: "text required" });
    if (!chatID) return res.status(400).json({ error: "chatID required" });

    chats[chatID][0].push({ role: "user", content: text});
    chats[chatID][1].push({ role: "user", content: `Users original question was:\n${text}`});
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "failed to take user text" });
  }
  res.json({ ok: true });
})

app.post("/api/message/edit", async (req, res) => {
  try {
    const { edit, chatID, index, sumIndex} = req.body;
    if (!edit) return res.status(400).json({ error: "text required" });
    if (!chatID) return res.status(400).json({ error: "chatID required" });

    chats[chatID][0][index] = { role: "user", content: edit};
    chats[chatID][1][sumIndex] = { role: "user", content: `Users original question was:\n${edit}`};
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "failed to take user text" });
  }
  res.json({ ok: true });
})

let eventBuffer = {}

app.get("/api/message/stream", async (req, res) => {
  const { chatID } = req.query;
  if (!chatID || !chats[chatID]) {
    res.status(400).json({ error: "valid chatID required" });
    return;
  }

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // respected by nginx & some PaaS
  res.flushHeaders?.();

  const state = getSseState(chatID);

  const sendEvent = (event, payload = {}) => {
    const id = state.nextId++;
    const trimmed = (event || "").trim();
    if (trimmed === "Heartbeat") {
      // send but do not buffer:
      writeSse(res, { id, event: trimmed, data: payload });
      return;
    }
    

    // Mutate payload to include a copy of event id if you want parity with existing client
    payload.event_id = id;

    // Server-side bookkeeping (your existing side-effects kept):
    
    if (trimmed === "answer") {
      chats[chatID].reasoningBuffer = "";
      chats[chatID][0].push({ role: "assistant", content: payload.answer });
      chats[chatID][1].push({ role: "assistant", content: payload.answer });
    }
    if (trimmed === "token") {
      chats[chatID].reasoningBuffer = payload.text;
    }

    let info = "";
    if ((trimmed === "status" || trimmed === "subStatus") && payload.stage) {
      info = payload.stage;
    }
    if (trimmed !== "Heartbeat") {
      console.log("Sent Event:", trimmed, info);
    }

    const message = { id, event: trimmed, data: payload, ts: Date.now() };
    pushToBuffer(chatID, message);
    writeSse(res, message);
  };

  // After headers & before you start sending new events:
  const lastIdHeader = req.headers["last-event-id"];
  const lastIdQuery = Number(req.query.lastEventId || 0);
  const lastId = Number(lastIdHeader || lastIdQuery || 0) || 0;

  if (lastId > 0) {
    const { buffer } = getSseState(chatID);
    // Replay anything newer than lastId
    for (const msg of buffer) {
      if (msg.id > lastId) writeSse(res, msg);
    }
  }


  async function heartBeat(signal) {
    while (!signal.aborted) {
      sendEvent("Heartbeat", {})
      await wait(10000)
    }
  }

  let currentChunk = -1;

  async function workflow(workingChunk, index, signal){
    let paragraph = "";
    while (currentChunk !== index){await wait(100)
      //console.log(currentConvoIndex + " ==? " + index)
    }
    if (Array.isArray(workingChunk)){
      paragraph = workingChunk[index];
    }
    else{
      paragraph = workingChunk
    }
    paragraph = paragraph.trim()
    if (streamClosed) return;
    sendEvent("subStatus", { stage: `working on chunk ${index}`, currentParagraph: paragraph });
    const shortSummary = await summarizeForSpeech(paragraph, chatID, signal);
    let ttsDataUrl = ''
    if (shortSummary !== ''){
        ttsDataUrl = await speakWithTTS(shortSummary);
        sendEvent("finishedParagraph", {ttsDataUrl, shortSummary, index});
    }
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
    sendEvent("status", { stage: "user quick response" });
    const intro_message = 'Write 1-2 short conversational sentences taking in the users question. Do not get into the content of the question. merly sound like you are thinking about it. Also phrase things in a unque way from the previous ones you\'ve done ';
    await workflow(intro_message, -1, signal);
    currentChunk ++; //todo get rid of this

    sendEvent("status", { stage: "reasoning" });


    let streamedAnswer = "";
    let chunks = [];

    let chunkIsOpen = false;
    let safeToSend = "";
    let buffer = "";

    const OPEN = "<開>";
    const CLOSE = "<閉>";
    const setOfDelineator = new Set(OPEN + CLOSE);
    const openRegex = new RegExp(OPEN, "g")
    const closeRegex = new RegExp(CLOSE, "g")


    await streamAnswer(chatID, {
      signal,
      onToken: async ({ token, text, done }) => {
        //console.log("running onToken");
        if (streamClosed) {
           const buffer = chats[chatID].reasoningBuffer
           chats[chatID][0].push({ role: "assistant", content: buffer});
           chats[chatID][0].push({ role: "user", content: "*USER INTERRUPTED ON CHUNK *" + paragraphIndex});
          return;
        }
        buffer += token

        let bufferSet = new Set(buffer);
        let intersection = new Set([...bufferSet].filter(x => setOfDelineator.has(x)));

        if (intersection.size === 0){
          true;
        }
        else {
          const opensplit = buffer.split(openRegex);
          if ((opensplit.length > 2) || (opensplit.length === 0)){
            throw new Error("((opensplit.length > 2) = " + (opensplit.length > 2) + ", (opensplit.length === 0) = " + (opensplit.length === 0));
          }
          if (opensplit.length === 2){
            if (chunkIsOpen === true){
              throw new Error("2 consective open chunks")
            }
            chunkIsOpen = true
            buffer = opensplit[1];
            if (opensplit[0].trim() !== ""){
              throw new Error("Buffer contains string before Open dilinator. String: " + opensplit[0].trim())
            }
          }

          const closesplit = buffer.split(closeRegex);
          if ((closesplit.length > 2) || (closesplit.length === 0)){
            throw new Error("((closesplit.length > 2) || (closesplit.length === 0)" + "\n buffer: " + buffer + "\n\n all text \n" + text);
          }
          if (closesplit.length === 2){
            if (chunkIsOpen === false){
              throw new Error("2 consective closed chunks")
            }
            chunkIsOpen = false
            buffer = closesplit[1];
            safeToSend += closesplit[0];
            chunks.push(closesplit[0])
            console.log(currentChunk + " , " + chunks.length + " , " + chunks[currentChunk])
            workflow(chunks, currentChunk).then(result => {
              currentChunk++;
            })
          }
        }
        if (done) {
          streamedAnswer = safeToSend?.trim() ?? "";
          sendEvent("answer", { answer: streamedAnswer });
        } else if (token) {
          sendEvent("token", { token, safeToSend});
        }
      }
    });

    sendEvent("done", {})
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
