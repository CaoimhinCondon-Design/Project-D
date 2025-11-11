# Obscura – LLM Audio Interface

Obscura is a browser-based audio + text interface to OpenAI models.

It lets you:

- Record speech in the browser
- Transcribe it with OpenAI’s Whisper
- Stream back an LLM answer
- Play the answer as TTS audio
- Persist chats in a Postgres database via Prisma

Everything is served from a single Node/Express backend with a simple front-end in `/public`.

---

## Table of Contents

- [Features](#features)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Environment Variables](#environment-variables)
- [Running with Docker (recommended)](#running-with-docker-recommended)
- [Running Locally Without Docker](#running-locally-without-docker)
- [Database & Prisma Migrations](#database--prisma-migrations)
- [Key HTTP Endpoints](#key-http-endpoints)
- [Troubleshooting](#troubleshooting)

---

## Features

- 🎙 **Voice input**
  - Record audio in the browser.
  - Client sends audio as `audio/webm` base64 to the backend.

- ✍️ **Automatic speech-to-text**
  - Backend uses OpenAI’s **Whisper** (`audio/transcriptions`) to turn speech into text.
  - Transcript is stored as a user message in the chat history.

- 🤖 **LLM responses**
  - Messages are sent to an OpenAI chat/completions endpoint.
  - Responses are streamed back to the client (Server-Sent Events).

- 🔊 **Text-to-speech playback**
  - The assistant’s answer is converted to audio and played back in order.
  - The UI queues audio so clips play sequentially.

- 💾 **Persistent chat history**
  - Chats, messages, and users are stored in a Postgres database using Prisma.
  - Sidebar lists multiple chats; each chat has its own message history.

---

## Tech Stack

**Backend**

- Node.js (ES modules)
- Express
- Prisma ORM
- Postgres
- OpenAI Node SDK

**Frontend**

- Vanilla JS in `public/app.js`
- Static HTML/CSS (`public/index.html`, `public/styles.css`)

**Infrastructure**

- Docker + Docker Compose (Postgres + Node server)
- `.env` + `.env.example` for configuration

---

## Project Structure

```text
Project-D/
  server.js              # Main Express server and API routes
  compose.yaml           # Docker Compose (server + Postgres)
  Dockerfile             # Node server container
  prisma/
    schema.prisma        # DB schema (User, Chat, Message, etc.)
    migrations/          # Prisma migrations
  public/
    index.html           # Frontend UI
    styles.css           # Basic styling
    app.js               # Frontend logic (recording, SSE, TTS, etc.)
  server/
    AI_APIs.js           # (placeholder for API helpers)
    dataControler.js     # (placeholder for data helpers)
  .env.example           # Example environment configuration
  package.json
  package-lock.json
