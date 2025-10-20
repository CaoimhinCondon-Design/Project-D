// Immediately Invoked Function Expression (IIFE) to avoid leaking variables into the global scope.
(() => {
  // ==============================
  // Config
  // ==============================
  const STREAM_ROUTE = "/api/message/stream"; // POST (transcript) + GET (SSE)
  const NEW_CHAT_ROUTE = "/api/new_chat";     // create chat IDs server-side

  // Voice detection config
  const FORCE_VAD = false;            // Set true to skip Web Speech and always use VAD
  const VAD_THRESH = 0.08;            // Voice activity RMS threshold (raise if too sensitive)
  const VAD_HANG_MS = 400;            // Hangover to avoid flapping during short pauses
  const AUTO_STOP_SILENCE_MS = 1200;  // If silent this long while recording -> auto stop & send
  const AUTO_STOP_MIN_MS = 500;       // Don't auto-stop before at least this much audio is captured

  // Debug
  const STREAM_DEBUG = true;

  // SSE forced close event
  const SSE_FORCE_EVENT = "SSE_FORCE_CLOSE";

  // ==============================
  // Session (multi-chat, per tab)
  // ==============================
  // session shape:
  // {
  //   currentChatID: string|null,
  //   chats: {
  //     [id]: {
  //       id, title, createdAt, lastUpdatedAt,
  //       messages: [{role:"user"|"assistant", content:string}]
  //     }
  //   }
  // }
  function loadSession() {
    try { return JSON.parse(sessionStorage.getItem("pd_session")) || { currentChatID: null, chats: {} }; }
    catch { return { currentChatID: null, chats: {} }; }
  }
  function saveSession(next) {
    sessionStorage.setItem("pd_session", JSON.stringify(next));
    renderChatList();
  }
  let state = loadSession();

  function upsertChat(id, patch = {}) {
    const prev = state.chats[id] || {
      id,
      title: `Chat ${id.slice(-4)}`,
      createdAt: Date.now(),
      lastUpdatedAt: Date.now(),
      messages: []
    };
    const next = { ...prev, ...patch, lastUpdatedAt: Date.now() };
    state.chats[id] = next;
    saveSession(state);
  }
  function setCurrentChat(id) {
    state.currentChatID = id;
    saveSession(state);
  }
  function getCurrentChat() {
    return state.currentChatID ? state.chats[state.currentChatID] : null;
  }

  // ==============================
  // State
  // ==============================
  // Recording
  let mediaRecorder;
  let mediaChunks = [];
  let activeStream = null;

  // Event stream / interrupt
  let currentEventSource = null;
  let interrupting = false;

  // SpeechRecognition / VAD
  let recognition = null;
  let recognitionRunning = false;
  let recognitionManuallyPaused = false;
  let vadStopFn = null;

  // Voice toggle
  let voiceEnabled = false;

  // SR error handling
  let srNetworkErrorCount = 0;
  const SR_NETWORK_ERROR_LIMIT = 3;
  const SR_ERROR_WINDOW_MS = 5000;
  let srErrorWindowStart = 0;

  // Auto-stop tracking
  let recordingStartedAt = 0;
  let lastSpeechTs = 0;
  let talking = false;
  let autoStopping = false;

  // Markdown / Code / Math
  let MD_READY = false;
  let HL_READY = false;
  let KATEX_READY = false;

  // ==============================
  // UI refs
  // ==============================
  const statusEl = document.getElementById("status");
  const startBtn = document.getElementById("startBtn");
  const stopBtn = document.getElementById("stopBtn");
  const voiceToggleBtn = document.getElementById("voiceToggle");
  const audioEl = document.getElementById("audio");

  // Chat UI
  const chatTitleEl = document.getElementById("chatTitle");
  const chatListEl = document.getElementById("chatList");
  const messagesEl = document.getElementById("messages");
  const newChatBtn = document.getElementById("newChatBtn");
  const deleteChatBtn = document.getElementById("deleteChatBtn");

  const statusLabels = {
    idle: "Idle",
    recording: "Recording...",
    processing: "Processing...",
    done: "Done",
    error: "Error",
  };

  // ==============================
  // Debug helper
  // ==============================
  function sLog(...args) {
    if (!STREAM_DEBUG) return;
    const ts = new Date().toISOString();
    console.log(`[stream ${ts}]`, ...args);
  }

  // ==============================
  // Audio queue for TTS clips
  // ==============================
  const audioQueue = [];
  let audioPlaying = false;

  function enqueueAudio(dataUrl) {
    if (!dataUrl) return;
    audioQueue.push(dataUrl);
    maybePlayNext();
  }

  function maybePlayNext() {
    if (audioPlaying) return;
    const next = audioQueue.shift();
    if (!next) return;
    audioPlaying = true;
    updateAudio(audioEl, next);
    audioEl.play().catch(() => {});
  }

  audioEl.addEventListener("ended", () => {
    audioPlaying = false;
    maybePlayNext();
  });

  // ==============================
  // Init
  // ==============================
  setStatus("idle");
  resetRecordingState();

  // core controls
  startBtn.addEventListener("click", handleStartToggle);
  stopBtn.addEventListener("click", handleStopRecording);
  attachVoiceToggle();

  // chat controls
  newChatBtn?.addEventListener("click", newChat);
  deleteChatBtn?.addEventListener("click", deleteCurrentChat);

  // ensure we have a chat on boot
  (async () => {
    if (!state.currentChatID) {
      await newChat();
    } else {
      renderChatHeader();
      renderMessages();
      renderChatList();
    }
  })().catch(console.error);

  // ==============================
  // Chat management
  // ==============================
  async function ensureServerChat() {
    const r = await fetch(NEW_CHAT_ROUTE, { credentials: "same-origin" });
    if (!r.ok) throw new Error(await r.text());
    const { chatID } = await r.json();
    if (!chatID) throw new Error("No chatID returned");
    return chatID;
  }

  async function newChat() {
    forceCloseSSE("new_chat");
    const id = await ensureServerChat();
    upsertChat(id, { id, title: "New Chat", messages: [] });
    setCurrentChat(id);
    renderChatHeader();
    renderMessages();
    renderChatList();
    updateAudio(audioEl, null);
    setStatus("idle");
  }

  async function deleteCurrentChat() {
    const id = state.currentChatID;
    if (!id) return;
    forceCloseSSE("delete_chat");
    delete state.chats[id];
    state.currentChatID = null;
    saveSession(state);
    const remaining = Object.keys(state.chats).sort(
      (a, b) => (state.chats[b].lastUpdatedAt || 0) - (state.chats[a].lastUpdatedAt || 0)
    );
    if (remaining.length === 0) {
      await newChat();
    } else {
      await switchChat(remaining[0]);
    }
  }

  async function switchChat(id) {
    if (!id || !state.chats[id]) return;
    forceCloseSSE("switch_chat");
    setCurrentChat(id);
    renderChatHeader();
    renderMessages();
    renderChatList();
    setStatus("idle");
  }

  // Sidebar rendering
  function renderChatList() {
    if (!chatListEl) return;
    const ids = Object.keys(state.chats).sort(
      (a, b) => (state.chats[b].lastUpdatedAt || 0) - (state.chats[a].lastUpdatedAt || 0)
    );
    chatListEl.innerHTML = "";
    ids.forEach((id) => {
      const c = state.chats[id];
      const item = document.createElement("button");
      item.className = "chat-list__item";
      item.type = "button";
      item.setAttribute("data-chatid", id);
      item.setAttribute("aria-current", id === state.currentChatID ? "true" : "false");
      item.textContent = c.title || id;
      item.addEventListener("click", () => switchChat(id));
      chatListEl.appendChild(item);
    });
  }

  function renderChatHeader() {
    const c = getCurrentChat();
    chatTitleEl.textContent = c?.title || "Project David";
  }

  function renderMessages() {
    const c = getCurrentChat();
    messagesEl.innerHTML = "";
    const msgs = c?.messages || [];
    for (const m of msgs) appendMessageBubble(m.role, m.content);
    scrollMessagesToBottom();
  }

  function appendMessageBubble(role, content) {
    const wrap = document.createElement("div");
    wrap.className = `msg msg--${role}`;

    const bubble = document.createElement("div");
    bubble.className = "msg__bubble";
    wrap.appendChild(bubble);

    // Render markdown into the bubble
    renderMarkdownInto(bubble, content);

    messagesEl.appendChild(wrap);
  }

  // Streaming-safe update for the *last* assistant bubble
  function updateLastAssistantBubble(text) {
    const nodes = messagesEl.querySelectorAll(".msg--assistant .msg__bubble");
    const target = nodes[nodes.length - 1];
    if (!target) {
      appendMessageBubble("assistant", text || "");
      return;
    }
    renderMarkdownInto(target, text || "");
  }

  function scrollMessagesToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ==============================
  // Voice toggle (SR with VAD fallback)
  // ==============================
  function attachVoiceToggle() {
    if (!voiceToggleBtn) return;
    updateVoiceToggleUi();

    voiceToggleBtn.addEventListener("click", async () => {
      if (!voiceEnabled) {
        await enableVoice();
      } else {
        await disableVoice();
      }
      updateVoiceToggleUi();
    });
  }

  async function enableVoice() {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      alert("Please allow microphone access to enable Voice mode.");
      return;
    }

    await startVADFallback();

    if (FORCE_VAD) {
      sLog("Voice: enabling VAD only (FORCE_VAD)");
      voiceEnabled = true;
      return;
    }

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      sLog("Voice: SR unavailable → using VAD only");
      voiceEnabled = true;
      return;
    }

    initSpeechRecognition(SR);
    safeStartRecognition();
    voiceEnabled = true;
  }

  async function disableVoice() {
    sLog("Voice: disabling");
    voiceEnabled = false;

    if (recognition) {
      recognitionManuallyPaused = true;
      try { recognition.stop(); } catch {}
    }

    if (typeof vadStopFn === "function") {
      try { vadStopFn(); } catch {}
      vadStopFn = null;
    }
  }

  function updateVoiceToggleUi() {
    if (!voiceToggleBtn) return;
    voiceToggleBtn.textContent = voiceEnabled ? "Disable Voice" : "Enable Voice";
    voiceToggleBtn.classList.toggle("button--active", voiceEnabled);
  }

  // ==============================
  // SpeechRecognition (wake/interrupt)
  // ==============================
  function initSpeechRecognition(SR) {
    if (recognition) return; // init once
    recognition = new SR();
    recognition.lang = navigator.language || "en-US";
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      recognitionRunning = true;
      sLog("SpeechRecognition started");
    };

    recognition.onend = () => {
      recognitionRunning = false;
      sLog("SpeechRecognition ended; manuallyPaused?", recognitionManuallyPaused);
      if (voiceEnabled && !recognitionManuallyPaused) setTimeout(safeStartRecognition, 600);
    };

    recognition.onaudiostart = () => {
      if (!voiceEnabled) return;
      sLog("SR onaudiostart → interrupt AI");
      interruptAI();
    };

    recognition.onresult = () => {};

    recognition.onerror = (e) => {
      const err = e?.error;
      sLog("SpeechRecognition error:", err);

      if (err === "network") {
        const now = Date.now();
        if (!srErrorWindowStart || now - srErrorWindowStart > SR_ERROR_WINDOW_MS) {
          srErrorWindowStart = now;
          srNetworkErrorCount = 0;
        }
        srNetworkErrorCount++;
        if (srNetworkErrorCount >= SR_NETWORK_ERROR_LIMIT && voiceEnabled) {
          sLog("Persistent SR network errors → continue with VAD only");
          recognitionManuallyPaused = true;
          try { recognition.stop(); } catch {}
        }
      }

      if (err === "not-allowed" || err === "service-not-allowed") {
        recognitionManuallyPaused = true;
        try { recognition.stop(); } catch {}
      }
    };

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && voiceEnabled && !recognitionManuallyPaused) {
        safeStartRecognition();
      }
    });
  }

  function safeStartRecognition() {
    if (!recognition || recognitionRunning) return;
    try { recognition.start(); } catch {}
  }

  function pauseRecognitionForRecording() {
    if (!recognition || !voiceEnabled) return;
    recognitionManuallyPaused = true;
    if (recognitionRunning) { try { recognition.stop(); } catch {} }
  }

  function resumeRecognitionAfterRecording() {
    if (!recognition || !voiceEnabled) return;
    recognitionManuallyPaused = false;
    safeStartRecognition();
  }

  // ==============================
  // VAD (also handles end-of-speech auto-stop)
  // ==============================
  async function startVADFallback() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const src = ac.createMediaStreamSource(stream);
      const analyser = ac.createAnalyser();
      analyser.fftSize = 2048;
      src.connect(analyser);

      const buf = new Float32Array(analyser.fftSize);

      sLog("VAD running (handles auto-stop on silence)");
      let rafId = 0;

      function loop() {
        if (!voiceEnabled) return;
        analyser.getFloatTimeDomainData(buf);

        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        const now = performance.now();

        if (rms > VAD_THRESH) {
          lastSpeechTs = now;
          if (!talking) {
            talking = true;
            sLog("VAD speech start");
            interruptAI();
            if (!isRecording()) {
              pauseRecognitionForRecording();
              handleStartRecording().catch((e) => sLog("VAD start recording failed:", e));
            }
          }
        } else {
          if (talking && now - lastSpeechTs > VAD_HANG_MS) {
            talking = false;
          }
        }

        if (isRecording()) {
          const recMs = now - recordingStartedAt;
          const silenceMs = now - lastSpeechTs;
          if (!autoStopping && recMs > AUTO_STOP_MIN_MS && silenceMs > AUTO_STOP_SILENCE_MS) {
            autoStopping = true;
            sLog(`Auto-stop: silence ${Math.round(silenceMs)}ms (rec ${Math.round(recMs)}ms) → stop & send`);
            handleStopRecording().finally(() => {
              autoStopping = false;
              resumeRecognitionAfterRecording();
            });
          }
        }

        rafId = requestAnimationFrame(loop);
      }
      loop();

      vadStopFn = () => {
        cancelAnimationFrame(rafId);
        try { ac.close(); } catch {}
        try { stream.getTracks().forEach(t => t.stop()); } catch {}
      };
    } catch (e) {
      sLog("VAD init failed:", e);
    }
  }

  // ==============================
  // Buttons / Recording flow
  // ==============================
  async function handleStartToggle() {
    try { if (audioEl && !audioEl.paused) audioEl.pause(); } catch {}
    forceCloseSSE("start_toggle");

    if (isRecording()) {
      await cancelRecording();
      return;
    }
    if (voiceEnabled) pauseRecognitionForRecording();
    await handleStartRecording();
  }

  async function handleStartRecording() {
    try {
      activeStream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : undefined;

      mediaRecorder = new MediaRecorder(activeStream, mime ? { mimeType: mime } : undefined);
      mediaChunks = [];
      recordingStartedAt = performance.now();
      lastSpeechTs = performance.now();

      mediaRecorder.addEventListener("dataavailable", ({ data }) => {
        if (data?.size) mediaChunks.push(data);
      });

      const stopPromise = new Promise((resolve) => {
        mediaRecorder.addEventListener(
          "stop",
          () => {
            const blob = new Blob(mediaChunks, { type: mediaRecorder.mimeType || "audio/webm" });
            resolve(blob);
          },
          { once: true }
        );
      });

      mediaRecorder._stopPromise = stopPromise;
      mediaRecorder.start();
      setStatus("recording");
      setButtonsState({ start: true, stop: false });
    } catch (err) {
      console.error(err);
      alert("Microphone permission is required.");
      resetRecordingState();
      if (voiceEnabled) resumeRecognitionAfterRecording();
    }
  }

  async function handleStopRecording() {
    if (!isRecording()) return;

    setButtonsState({ start: true, stop: true });
    setStatus("processing");

    const stopPromise = mediaRecorder._stopPromise;
    mediaRecorder.stop();

    if (activeStream) {
      activeStream.getTracks().forEach((t) => t.stop());
      activeStream = null;
    }

    try {
      const blob = await stopPromise;
      const audioBase64 = await blobToBase64(blob);

      const POST_TIMEOUT_MS = 30000;
      const ctrl = new AbortController();
      const postTimer = setTimeout(() => ctrl.abort("post_timeout"), POST_TIMEOUT_MS);

      let postRes;
      try {
        // include chatID with POST
        postRes = await fetch(STREAM_ROUTE, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "Cache-Control": "no-cache",
          },
          credentials: "same-origin",
          body: JSON.stringify({ audioBase64, chatID: state.currentChatID }),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(postTimer);
      }

      if (!postRes?.ok) {
        const msg = (await postRes?.text()?.catch(() => "")) || "";
        throw new Error(`POST ${STREAM_ROUTE} failed: ${postRes?.status} ${msg}`);
      }

      const { transcript } = await postRes.json();
      sLog("Transcript from POST:", transcript?.slice(0, 160) || "<empty>");

      // Append user message and maybe set title
      const c = getCurrentChat();
      const newMessages = [...(c.messages || []), { role: "user", content: transcript || "" }];
      const title = (c.title === "New Chat" || !c.messages?.length)
        ? (transcript || "New Chat").slice(0, 48)
        : c.title;

      upsertChat(state.currentChatID, { messages: newMessages, title });

      renderChatHeader();
      appendMessageBubble("user", transcript || "");
      // create placeholder assistant bubble (will stream into it)
      appendMessageBubble("assistant", "");
      scrollMessagesToBottom();

      audioQueue.length = 0;
      audioPlaying = false;
      updateAudio(audioEl, null);

      await openEventStream();
      setStatus("done");
    } catch (err) {
      console.error(err);
      alert("Something went wrong while sending/streaming.");
      setStatus("error");
    } finally {
      resetRecordingState();
      if (voiceEnabled) resumeRecognitionAfterRecording();
    }
  }

  async function cancelRecording() {
    sLog("Cancel recording");
    setStatus("idle");
    setButtonsState({ start: false, stop: true });

    try {
      if (isRecording()) mediaRecorder.stop();
    } catch {}

    if (activeStream) {
      try { activeStream.getTracks().forEach((t) => t.stop()); } catch {}
      activeStream = null;
    }

    mediaRecorder = null;
    mediaChunks = [];

    if (voiceEnabled) resumeRecognitionAfterRecording();
  }

  function isRecording() {
    return mediaRecorder && mediaRecorder.state === "recording";
  }

  // ==============================
  // Networking — GET SSE
  // ==============================
  async function openEventStream() {
    const id = state.currentChatID;
    if (!id) return;

    sLog("Opening GET SSE:", STREAM_ROUTE, "chatID=", id);

    const IDLE_TIMEOUT_MS = 20000;
    const HARD_CLOSE_MS    = 120000;

    return new Promise((resolve, reject) => {
      const url = `${STREAM_ROUTE}?chatID=${encodeURIComponent(id)}`;
      const es = new EventSource(url, { withCredentials: true });
      currentEventSource = es;

      let lastActivity = Date.now();
      let hardCloseAt  = Date.now() + HARD_CLOSE_MS;
      let lastAnswerText = "";
      let sawAnyData = false;
      let resolved = false;

      function clearAll() {
        try { clearInterval(watchdog); } catch {}
        try { window.removeEventListener(SSE_FORCE_EVENT, onForcedClose); } catch {}
      }

      function end(ok, why = "") {
        if (resolved) return;
        resolved = true;
        clearAll();
        try { es.close(); } catch {}
        if (currentEventSource === es) currentEventSource = null;
        sLog(`SSE ended ok=${ok} ${why ? "(" + why + ")" : ""}`);
        ok ? resolve() : reject(new Error("SSE error: " + why));
      }

      function bumpActivity() { lastActivity = Date.now(); }

      const onForcedClose = () => end(true, "externally_closed");
      window.addEventListener(SSE_FORCE_EVENT, onForcedClose, { once: true });

      const watchdog = setInterval(() => {
        const now = Date.now();
        if (now - lastActivity > IDLE_TIMEOUT_MS) {
          setStatus("done");
          end(true, "idle_timeout");
        } else if (now > hardCloseAt) {
          setStatus("done");
          end(true, "hard_close");
        }
      }, 1000);

      const handleStatus = (data) => {
        bumpActivity();
        const stage = data?.stage ? ` (${data.stage})` : "";
        setStatusLabel(`Processing${stage}`);
      };

      es.addEventListener("open", () => { bumpActivity(); });

      es.addEventListener("status", (e) => { sawAnyData = true; handleStatus(safeParse(e.data)); });
      es.addEventListener("subStatus", (e) => { sawAnyData = true; handleStatus(safeParse(e.data)); });

      es.addEventListener("token", (e) => {
        bumpActivity(); sawAnyData = true;
        const data = safeParse(e.data);
        // streaming tokens: update UI and snapshot
        if (typeof data?.text === "string") {
          lastAnswerText = data.text;
        } else if (typeof data?.token === "string") {
          lastAnswerText += data.token;
        }
        updateLastAssistantBubble(lastAnswerText);

        const c = getCurrentChat();
        const msgs = [...(c.messages || [])];
        // ensure there is an assistant message at the end to replace
        if (!msgs.length || msgs[msgs.length - 1].role !== "assistant") {
          msgs.push({ role: "assistant", content: lastAnswerText });
        } else {
          msgs[msgs.length - 1] = { role: "assistant", content: lastAnswerText };
        }
        upsertChat(state.currentChatID, { messages: msgs });

        scrollMessagesToBottom();
      });

      es.addEventListener("answer", (e) => {
        bumpActivity(); sawAnyData = true;
        const data = safeParse(e.data);
        lastAnswerText = data?.answer || lastAnswerText;

        updateLastAssistantBubble(lastAnswerText);

        const c = getCurrentChat();
        const msgs = [...(c.messages || [])];
        if (!msgs.length || msgs[msgs.length - 1].role !== "assistant") {
          msgs.push({ role: "assistant", content: lastAnswerText });
        } else {
          msgs[msgs.length - 1] = { role: "assistant", content: lastAnswerText };
        }
        upsertChat(state.currentChatID, { messages: msgs });

        scrollMessagesToBottom();
      });

      es.addEventListener("finishedParagraph", (e) => {
        bumpActivity(); sawAnyData = true;
        const data = safeParse(e.data);
        if (data?.ttsDataUrl) enqueueAudio(data.ttsDataUrl);
      });

      es.addEventListener("done", () => {
        setStatus("done");
        end(true, "server_done_event");
      });

      es.addEventListener("error", (e) => {
        const payload = safeParse(e?.data || "");
        if (payload?.message) {
          // render an error bubble
          appendMessageBubble("assistant", `**Error:** ${payload.message}`);
          setStatus("error");
          end(false, "server_error_event");
        } else {
          if (sawAnyData) {
            setStatus("done");
            end(true, "onerror_after_data");
          } else {
            setStatus("error");
            end(false, "onerror_no_data");
          }
        }
      });
    });
  }

  // ==============================
  // Interrupt logic
  // ==============================
  function interruptAI() {
    if (interrupting) return;
    interrupting = true;

    try {
      audioQueue.length = 0;
      if (!audioEl.paused) audioEl.pause();
      updateAudio(audioEl, null);
      audioPlaying = false;
    } catch {}

    forceCloseSSE("interrupt");

    setStatusLabel("Listening…");

    if (!isRecording()) {
      if (voiceEnabled) pauseRecognitionForRecording();
      handleStartRecording().finally(() => {
        interrupting = false;
      });
    } else {
      interrupting = false;
    }
  }

  function forceCloseSSE(reason = "client_close") {
    if (currentEventSource) {
      try { currentEventSource.close(); } catch {}
      currentEventSource = null;
      try { window.dispatchEvent(new CustomEvent(SSE_FORCE_EVENT)); } catch {}
      sLog("SSE: force-closed (" + reason + ")");
    }
  }

  // ==============================
  // Markdown / Code / LaTeX support (best-effort loaders)
  // ==============================
  async function renderMarkdownInto(el, mdText) {
    await ensureMarkdown();
    const src = normalizeFences(mdText || "");
    if (window.marked && window.DOMPurify) {
      try {
        const html = DOMPurify.sanitize(marked.parse(src));
        el.innerHTML = html;
      } catch {
        el.textContent = src;
      }
    } else {
      el.textContent = src;
    }

    // highlight
    try {
      await ensureHighlighting();
      if (window.hljs) {
        el.querySelectorAll("pre code").forEach(block => {
          try { window.hljs.highlightElement(block); } catch {}
        });
      }
    } catch {}

    // katex
    try {
      await ensureKatex();
      if (window.renderMathInElement && window.katex) {
        window.renderMathInElement(el, {
          delimiters: [
            { left: "$$", right: "$$", display: true },
            { left: "\\[", right: "\\]", display: true },
            { left: "$",  right: "$",  display: false },
            { left: "\\(", right: "\\)", display: false },
          ],
          throwOnError: false,
          strict: "warn",
          trust: false,
          macros: { "\\RR": "\\mathbb{R}", "\\NN": "\\mathbb{N}", "\\ZZ": "\\mathbb{Z}" }
        });
      }
    } catch {}
  }

  function loadCssOnce(href, key) {
    if (document.querySelector(`link[data-key="${key}"]`)) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.setAttribute("data-key", key);
    document.head.appendChild(link);
  }

  function loadScriptOnce(src, key) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[data-key="${key}"]`)) return resolve();
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.setAttribute("data-key", key);
      s.onload = resolve;
      s.onerror = () => reject(new Error("Failed to load " + src));
      document.head.appendChild(s);
    });
  }

  async function loadScriptWithFallback(urls, key, timeoutMs = 8000) {
    for (const url of urls) {
      try {
        await Promise.race([
          loadScriptOnce(url, key),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs))
        ]);
        return true;
      } catch {}
    }
    return false;
  }

  function normalizeFences(md) {
    return (md || "").replace(/[‘’‛‚`´]/g, "`");
  }

  async function ensureMarkdown() {
    if (MD_READY) return;
    if (!window.marked) {
      await loadScriptWithFallback(
        [
          "https://cdn.jsdelivr.net/npm/marked/marked.min.js",
          "https://unpkg.com/marked@latest/marked.min.js",
          "https://cdnjs.cloudflare.com/ajax/libs/marked/14.1.2/marked.min.js"
        ],
        "marked"
      );
    }
    if (!window.DOMPurify) {
      await loadScriptWithFallback(
        [
          "https://cdn.jsdelivr.net/npm/dompurify@3.0.6/dist/purify.min.js",
          "https://unpkg.com/dompurify@3.0.6/dist/purify.min.js",
          "https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.0.6/purify.min.js"
        ],
        "dompurify"
      );
    }
    if (window.marked) {
      try {
        marked.setOptions({ breaks: true, gfm: true, mangle: false, headerIds: true });
      } catch {}
    }
    MD_READY = true;
  }

  async function ensureHighlighting() {
    if (HL_READY) return;
    loadCssOnce("https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github.min.css", "hljs-theme")
      || loadCssOnce("https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css", "hljs-theme2");
    const ok = window.hljs || await loadScriptWithFallback(
      [
        "https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/build/highlight.min.js",
        "https://unpkg.com/highlight.js@11.9.0/build/highlight.min.js",
        "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"
      ],
      "hljs"
    );
    HL_READY = !!window.hljs;
  }

  async function ensureKatex() {
    if (KATEX_READY && window.katex && window.renderMathInElement) return;
    loadCssOnce("https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css", "katex-css")
      || loadCssOnce("https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.11/katex.min.css", "katex-css2");

    if (!window.katex) {
      await loadScriptWithFallback(
        [
          "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js",
          "https://unpkg.com/katex@0.16.11/dist/katex.min.js",
          "https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.11/katex.min.js"
        ],
        "katex"
      );
    }
    if (!window.renderMathInElement) {
      await loadScriptWithFallback(
        [
          "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js",
          "https://unpkg.com/katex@0.16.11/dist/contrib/auto-render.min.js",
          "https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.11/contrib/auto-render.min.js"
        ],
        "katex-auto"
      );
    }
    KATEX_READY = !!(window.katex && window.renderMathInElement);
  }

  // ==============================
  // Helpers
  // ==============================
  function safeParse(s) {
    try { return JSON.parse(s); } catch { return null; }
  }

  function updateAudio(el, dataUrl) {
    if (dataUrl) {
      el.src = dataUrl;
      el.removeAttribute("hidden");
      el.load();
      el.play().catch(() => {});
    } else {
      el.setAttribute("hidden", "hidden");
      el.removeAttribute("src");
      el.load();
    }
  }

  function setButtonsState({ start, stop }) {
    startBtn.disabled = !!start;
    stopBtn.disabled = !!stop;
  }

  function setStatus(state) {
    const label = statusLabels[state] ?? statusLabels.idle;
    statusEl.dataset.state = state;
    statusEl.textContent = label;
  }

  function setStatusLabel(text) {
    statusEl.dataset.state = "processing";
    statusEl.textContent = text;
  }

  function resetRecordingState() {
    setButtonsState({ start: false, stop: true });
    mediaRecorder = null;
    mediaChunks = [];
    if (activeStream) { activeStream.getTracks().forEach((t) => t.stop()); activeStream = null; }
  }

  async function blobToBase64(blob) {
    const buffer = await blob.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return window.btoa(binary);
  }
})();