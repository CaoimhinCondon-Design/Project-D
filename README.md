# Project David

Project David is a minimal Node.js MVP that turns microphone input into a conversational exchange with OpenAI. The browser captures audio, the server handles transcription and reasoning, and the client receives both text and a spoken summary.

## Features
- One-click browser UI to record audio with the MediaRecorder API.
- Express server pipeline: Whisper transcription ➜ GPT reasoning ➜ short summary ➜ OpenAI text-to-speech.
- Optional Server-Sent Events (SSE) endpoint for token streaming while the request is processed.
- Optional WebSocket helper for the OpenAI Realtime API when you need live synthesized speech.
- Zero build tooling – static assets are served directly from `public/`.

## Project Structure
```
.
├─ public/          # Static client (HTML, CSS, JS)
├─ server.js        # Express server and OpenAI integrations
├─ package.json     # npm scripts and dependencies
└─ .env             # Local environment variables (not committed)
```

## Requirements
- Node.js ≥ 20 (provides `fetch`, `FormData`, `Blob`, `EventTarget`, etc.).
- npm ≥ 9.
- An OpenAI API key with access to the Whisper, GPT-4o mini, and Text-to-Speech endpoints.

## Environment Variables
Create a `.env` file in the project root (copy the example below). Only `OPENAI_API_KEY` is required; the others are optional.

```
OPENAI_API_KEY=sk-...
# PORT=3000
# OPENAI_REALTIME_MODEL=gpt-realtime-mini
# OPENAI_REALTIME_VOICE=verse
```

## Installation
```bash
npm install
```

## Run the App
```bash
# Hot reload for development
npm run dev

# Production-style start
npm start
```
Visit `http://localhost:3000` and allow microphone access when prompted.

## Using the UI
1. Click **Start Recording** to capture microphone audio (WebM/Opus).
2. Click **Stop & Send** to upload the recording as Base64 to the server.
3. Wait for the transcript, the full answer, and a short spoken summary to appear.
4. Replay the summary with the built-in audio player. Autoplay is attempted but may require a manual click depending on browser settings.

## API Reference
### `POST /api/message`
Body:
```json
{
  "audioBase64": "<base64-encoded webm/opus audio>"
}
```
Response:
```json
{
  "transcript": "...",
  "answer": "...",
  "shortSummary": "...",
  "ttsDataUrl": "data:audio/mpeg;base64,..."
}
```

### `POST /api/message/stream`
Streams progress using Server-Sent Events. Event types include:
- `status` (`{ stage: "transcribing" | "reasoning" | "summarizing" | "speaking" }`)
- `transcript`
- `token` (incremental GPT tokens while reasoning)
- `answer` (final full answer when complete)
- `summary`
- `speech` (final data URL for playback)
- `done`
- `error`

Clients can use `EventSource` or similar SSE helpers to subscribe.

## Optional Realtime Voice
`server.js` also contains a `speakWithRealtime` helper that connects to the OpenAI Realtime API via WebSocket (`gpt-realtime-mini` by default). It is not wired into the HTTP flow but demonstrates how to request streaming audio if you need lower-latency synthesized speech.

## Development Notes
- The server accepts payloads up to 25 MB to accommodate short voice clips.
- Static assets are served from `public/`; adjust or extend the client without a bundler.
- Handle microphone permission errors on the client; the UI resets gracefully but reports failures in the console.
- For longer audio or different codecs, update the MediaRecorder settings and ensure the server decodes the format you send.

## Troubleshooting
- **403 / 401 from OpenAI**: confirm your `OPENAI_API_KEY` and model access level.
- **`fetch` or `FormData` not found**: upgrade Node.js to v20 or later.
- **No audio playback**: browsers may block autoplay; ask the user to press play manually.
