// Immediately Invoked Function Expression (IIFE) to avoid leaking variables into the global scope.
(() => {
  // ==============================
  // Config
  // ==============================
  const STREAM_ROUTE = "/api/message/stream";   // POST (transcript) + GET (SSE)
  const NEW_CHAT_ROUTE = "/api/new_chat";       // create chat IDs server-side
  const RAW_TEXT_ROUTE = "/api/message/raw_text"; // manual text submissions

  // Voice detection config
  const FORCE_VAD = true;              // Force VAD-only (prevents Web Speech false wakes/mis-lang)
  const VOICE_LANG = "en-US";          // Language hint for SR if ever enabled
  const VAD_CALIBRATION_MS = 1500;     // Ambient calibration window
  const VAD_RMS_SMOOTH = 0.40;         // EMA smoothing factor [0..1]
  const VAD_STD_K = 1.30;              // Dynamic threshold = mean + K*std
  const VAD_THRESH = 0.003;            // Absolute minimum threshold (fallback)
  const VAD_HANG_MS = 1000;            // Debounce after last energy before "not speaking"
  const VAD_START_CONFIRM_MS = 120;    // Must stay above threshold this long to confirm start

  // Turn auto-stop
  const AUTO_STOP_SILENCE_MS = 500;   // If silent this long while recording -> auto stop & send
  const AUTO_STOP_MIN_MS = 500;        // Don't auto-stop before at least this much audio is captured

  // Minimum length gates 
  const MIN_SPEECH_MS = 1000;          // Require at least 1s total utterance duration
  const MIN_ACTIVE_SPEECH_MS = 400;    // Require ≥400ms actually above threshold
  const MIN_SNR_DB = 7;                // Peak SNR vs ambient must exceed 7 dB
  const MIN_PEAK_RMS = 0.010;          // Peak RMS must exceed this absolute value

  // Debug
  const STREAM_DEBUG = true;

  // SSE forced close event
  const SSE_FORCE_EVENT = "SSE_FORCE_CLOSE";

  // ==============================
  // Session (multi-chat, per tab)
  // ==============================
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
  let composerLocked = false;

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

  // VAD stats for quality gating
  let vadStats = {
    calMean: 0,
    peakRms: 0,
    activeSpeechMs: 0
  };
  let startCandidateAt = 0;

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
  const volumeSlider = document.getElementById("volumeSlider");
  const textForm = document.getElementById("textComposer");
  const textInput = document.getElementById("textInput");
  const sendTextBtn = document.getElementById("sendTextBtn");

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
  // Audio queue for TTS clips (ordered)
  // ==============================
  const audioQueue = [];
  let audioPlaying = false;
  let nextTtsIndex = 0;
  const ttsBuffer = new Map(); // index -> dataUrl

  function enqueueAudioOrdered(index, dataUrl) {
    if (!dataUrl) return;
    if (typeof index === "number" && index < 0) {
      audioQueue.unshift(dataUrl);
      maybePlayNext();
      return;
    }
    if (typeof index !== "number") {
      enqueueAudio(dataUrl);
      return;
    }
    ttsBuffer.set(index, dataUrl);
    maybeFlushTtsBuffer();
  }
  function maybeFlushTtsBuffer() {
    while (ttsBuffer.has(nextTtsIndex)) {
      audioQueue.push(ttsBuffer.get(nextTtsIndex));
      ttsBuffer.delete(nextTtsIndex);
      nextTtsIndex++;
    }
    maybePlayNext();
  }
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
  if (audioEl) {
    audioEl.addEventListener("ended", () => {
      audioPlaying = false;
      maybePlayNext();
    });
  }
  if (audioEl && volumeSlider) {
    const applyVolumeFromSlider = () => {
      const value = parseFloat(volumeSlider.value);
      if (!Number.isFinite(value)) return;
      audioEl.volume = Math.min(1, Math.max(0, value));
    };
    applyVolumeFromSlider();
    volumeSlider.addEventListener("input", applyVolumeFromSlider);
    volumeSlider.addEventListener("change", applyVolumeFromSlider);
  }

  // ==============================
  // Init
  // ==============================
  setStatus("idle");
  resetRecordingState();

  textForm?.addEventListener("submit", handleTextSubmit);
  // core controls (manual buttons still supported)
  startBtn?.addEventListener("click", handleStartToggle);
  stopBtn?.addEventListener("click", handleStopRecording);
  attachVoiceToggle();

  // chat controls
  newChatBtn?.addEventListener("click", newChat);
  deleteChatBtn?.addEventListener("click", deleteCurrentChat);

  // ensure we have a chat on boot
  (async () => {
    const reset = resetChatStateForServerRestart();
    if (reset) {
      renderChatList();
    }
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
    upsertChat(id, { id, title: "New Chat", messages: [], archived: false, serverSynced: true });
    setCurrentChat(id);
    renderChatHeader();
    renderMessages();
    renderChatList();
    updateAudio(audioEl, null);
    setStatus("idle");
    nextTtsIndex = 0;
    audioQueue.length = 0;
    audioPlaying = false;
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
    nextTtsIndex = 0;
    audioQueue.length = 0;
    audioPlaying = false;
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
      const archived = !!c?.archived;
      item.dataset.archived = archived ? "true" : "false";
      if (archived) {
        item.title = "Archived conversation (read only)";
        item.classList.add("chat-list__item--archived");
      } else {
        item.removeAttribute("title");
        item.classList.remove("chat-list__item--archived");
      }
      item.textContent = c?.title || id;
      item.addEventListener("click", () => switchChat(id));
      chatListEl.appendChild(item);
    });
  }
  function renderChatHeader() {
    const c = getCurrentChat();
    if (chatTitleEl) chatTitleEl.textContent = c?.title || "Project David";
    setComposerEnabled(!c?.archived);
  }
  function renderMessages() {
    const c = getCurrentChat();
    if (!messagesEl) return;
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
    renderMarkdownInto(bubble, content);
    messagesEl.appendChild(wrap);
  }
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

  function markChatAsArchived(id, { updateTitle = true } = {}) {
    if (!id || !state.chats[id]) return;
    const chat = state.chats[id];
    const suffix = " (archived)";
    let title = chat.title || `Chat ${id.slice(-4)}`;
    if (updateTitle) {
      const lower = title.toLowerCase();
      if (!lower.includes("archived")) {
        title = `${title}${suffix}`;
      }
    }
    upsertChat(id, {
      title,
      archived: true,
      serverSynced: false,
    });
  }

  async function ensureActiveChat(reason = "unspecified") {
    let chat = getCurrentChat();
    if (!chat) {
      await newChat();
      return getCurrentChat();
    }
    if (chat.archived || chat.serverSynced === false) {
      markChatAsArchived(chat.id, { updateTitle: true });
      await newChat();
      chat = getCurrentChat();
    }
    return chat;
  }

  async function handleServerDesync(reason = "server_desync") {
    const current = getCurrentChat();
    if (current) {
      markChatAsArchived(current.id, { updateTitle: true });
    }
    await newChat();
    return getCurrentChat();
  }

  function resetChatStateForServerRestart() {
    const ids = Object.keys(state.chats);
    if (!ids.length) return false;
    let mutated = false;
    ids.forEach((id) => {
      const chat = state.chats[id];
      if (!chat) return;
      if (!chat.archived || chat.serverSynced !== false) {
        mutated = true;
      }
      chat.archived = true;
      chat.serverSynced = false;
      const suffix = " (archived)";
      if (chat.title) {
        const lower = chat.title.toLowerCase();
        if (!lower.includes("archived")) {
          chat.title = `${chat.title}${suffix}`;
        }
      } else {
        chat.title = `Chat ${id.slice(-4)}${suffix}`;
      }
    });
    let currentCleared = false;
    if (state.currentChatID) {
      const active = state.chats[state.currentChatID];
      if (!active || active.archived || active.serverSynced === false) {
        state.currentChatID = null;
        currentCleared = true;
      }
    }
    if (mutated || currentCleared) {
      try {
        sessionStorage.setItem("pd_session", JSON.stringify(state));
      } catch {}
    }
    return mutated || currentCleared;
  }

  function setComposerEnabled(enabled) {
    composerLocked = !enabled;
    const disable = !enabled;
    if (disable && isRecording()) {
      cancelRecording().catch(() => {});
    }
    if (disable && voiceEnabled) {
      disableVoice().catch(() => {});
    }
    if (textInput) textInput.disabled = disable;
    if (sendTextBtn) sendTextBtn.disabled = disable;
    if (voiceToggleBtn) voiceToggleBtn.disabled = disable;
    if (volumeSlider) volumeSlider.disabled = disable;
    if (disable) {
      if (startBtn) startBtn.disabled = true;
      if (stopBtn) stopBtn.disabled = true;
      return;
    }
    setButtonsState({ start: isRecording(), stop: !isRecording() });
  }

  function isServerDesyncError(err) {
    const status = err?.status ?? err?.responseStatus;
    return typeof status === "number" && status >= 500;
  }

  async function commitUserMessage(userText) {
    const chat = getCurrentChat();
    if (!chat || !state.currentChatID || chat.archived) return;

    const messageContent = userText ?? "";
    const newMessages = [...(chat.messages || []), { role: "user", content: messageContent }];
    const title = (chat.title === "New Chat" || !chat.messages?.length)
      ? (messageContent || "New Chat").slice(0, 48)
      : chat.title;

    upsertChat(state.currentChatID, { messages: newMessages, title });

    renderChatHeader();
    appendMessageBubble("user", messageContent);
    appendMessageBubble("assistant", "");
    scrollMessagesToBottom();

    audioQueue.length = 0;
    audioPlaying = false;
    updateAudio(audioEl, null);
    nextTtsIndex = 0;
    ttsBuffer.clear?.();

    await openEventStream();
    setStatus("done");
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
    await startVADFallback(); // start detection (does NOT start recording yet)

    // Initialize Web Speech only if not forcing VAD
    try {
      if (!FORCE_VAD) {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (SR) {
          initSpeechRecognition(SR);
          safeStartRecognition();
        }
      }
    } catch {}

    voiceEnabled = true;
  }
  async function disableVoice() {
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
  // SpeechRecognition (used only to wake/interrupt if enabled)
  // ==============================
  function initSpeechRecognition(SR) {
    if (recognition) return; // init once
    recognition = new SR();
    recognition.lang = VOICE_LANG;
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => { recognitionRunning = true; sLog("SpeechRecognition started"); };
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
  // VAD (auto start/stop recording)
  // ==============================
  async function startVADFallback() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          noiseSuppression: false,
          echoCancellation: false,
          autoGainControl: false
        }
      });

      const ac = new (window.AudioContext || window.webkitAudioContext)();
      if (ac.state === "suspended") {
        try { await ac.resume(); } catch {}
      }
      const src = ac.createMediaStreamSource(stream);
      const analyser = ac.createAnalyser();
      analyser.fftSize = 2048;
      src.connect(analyser);

      const buf = new Float32Array(analyser.fftSize);

      sLog("VAD starting (with calibration)...");
      setStatusLabel("Listening…");

      // ---- Calibration for ambient ----
      let calSamples = [];
      const calStart = performance.now();
      while (performance.now() - calStart < VAD_CALIBRATION_MS) {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        calSamples.push(rms);
        await new Promise(r => requestAnimationFrame(r));
      }
      const calMean = calSamples.reduce((a, b) => a + b, 0) / Math.max(1, calSamples.length);
      const calVar = calSamples.reduce((acc, v) => acc + Math.pow(v - calMean, 2), 0) / Math.max(1, calSamples.length);
      const calStd = Math.sqrt(calVar);
      vadStats.calMean = calMean;
      sLog("VAD calibrated:", { mean: calMean.toFixed(4), std: calStd.toFixed(4) });

      // ---- Loop ----
      let emaRms = calMean;
      let lastAboveTs = 0;
      let speaking = false;

      let rafId = 0;
      function loop() {
        if (!voiceEnabled) return;

        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const instRms = Math.sqrt(sum / buf.length);

        // EMA smoothing
        emaRms = VAD_RMS_SMOOTH * instRms + (1 - VAD_RMS_SMOOTH) * emaRms;

        // Dynamic threshold
        const dynThresh = Math.max(calMean + VAD_STD_K * calStd, VAD_THRESH);

        const now = performance.now();

        // --- START gating (require continuous above for VAD_START_CONFIRM_MS) ---
        if (emaRms > dynThresh) {
          if (!startCandidateAt) startCandidateAt = now;
          lastAboveTs = now;

          // If not yet speaking, confirm start after continuous above-threshold window
          if (!speaking && (now - startCandidateAt) >= VAD_START_CONFIRM_MS) {
            speaking = true;
            talking = true;
            setStatusLabel("Speaking…");

            // Reset VAD quality counters at utterance start
            vadStats.peakRms = 0;
            vadStats.activeSpeechMs = 0;

            // On voice onset, interrupt any current stream/tts and start a fresh recording.
            try {
              interruptAI();
            } catch (e) {
              sLog("Interrupt on VAD onset failed:", e);
              if (!isRecording()) {
                pauseRecognitionForRecording();
                handleStartRecording().catch((err) => sLog("VAD start recording failed:", err));
              }
            }
          }
        } else {
          startCandidateAt = 0; // reset start candidate when we drop below
          // only flip to not speaking after hang window
          if (speaking && (now - lastAboveTs > VAD_HANG_MS)) {
            speaking = false;
            talking = false;
            setStatusLabel("Listening…");
          }
        }

        // --- While recording, track quality metrics ---
        if (isRecording()) {
          // Track peak RMS (use instantaneous, not EMA)
          if (instRms > vadStats.peakRms) vadStats.peakRms = instRms;

          // Accumulate time we are actually above threshold
          if (emaRms > dynThresh) {
            // Approximate per frame duration by RAF cadence (~16ms); more robust: use delta time
            const dt = 1000 / 60; // ~16.7ms
            vadStats.activeSpeechMs += dt;
          }

          const recMs = now - recordingStartedAt;
          const silenceMs = now - lastAboveTs;

          // Require at least MIN_SPEECH_MS before auto-stop can fire
          if (!autoStopping && recMs > Math.max(AUTO_STOP_MIN_MS, MIN_SPEECH_MS) && silenceMs > AUTO_STOP_SILENCE_MS) {
            autoStopping = true;
            sLog(`Auto-stop: silence ${Math.round(silenceMs)}ms (rec ${Math.round(recMs)}ms) → stop & maybe send`);
            handleStopRecording().finally(() => {
              autoStopping = false;
              resumeRecognitionAfterRecording();
            });
          }
        }

        rafId = requestAnimationFrame(loop);
      }
      rafId = requestAnimationFrame(loop);

      vadStopFn = () => {
        cancelAnimationFrame(rafId);
        try { ac.close(); } catch {}
        try { stream.getTracks().forEach(t => t.stop()); } catch {}
        setStatus("idle");
      };

    } catch (e) {
      sLog("VAD init failed:", e);
      alert("Failed to initialize Voice Activity Detection. Check mic permissions.");
    }
  }

  async function postRawTextMessage(chatID, message) {
    const controller = new AbortController();
    const POST_WAIT_MS = 800;

    const payload = JSON.stringify({ text: message, chatID });

    const fetchPromise = fetch(RAW_TEXT_ROUTE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Cache-Control": "no-cache",
      },
      credentials: "same-origin",
      body: payload,
      signal: controller.signal,
    });

    let timeoutId;
    const timeoutPromise = new Promise((resolve) => {
      timeoutId = setTimeout(() => resolve("timeout"), POST_WAIT_MS);
    });

    const result = await Promise.race([
      fetchPromise.then(async (res) => {
        if (!res.ok) {
          const msg = (await res.text().catch(() => "")) || "";
          const error = new Error(`POST ${RAW_TEXT_ROUTE} failed: ${res.status} ${msg}`);
          error.status = res.status;
          error.responseText = msg;
          throw error;
        }
        return "ok";
      }).catch((err) => {
        if (err?.name === "AbortError") {
          return "timeout";
        }
        throw err;
      }),
      timeoutPromise,
    ]);

    clearTimeout(timeoutId);

    if (result === "timeout") {
      controller.abort();
      sLog("Text submission POST timed out; assuming server accepted request.");
    }
    return result;
  }

  // ==============================
  // Manual text submission
  // ==============================
  async function handleTextSubmit(event) {
    event.preventDefault();
    if (!textInput) return;

    const rawValue = textInput.value;
    const message = rawValue.trim();
    if (!message) return;

    forceCloseSSE("text_submit");
    setStatus("processing");
    textInput.disabled = true;
    if (sendTextBtn) sendTextBtn.disabled = true;

    try {
      await ensureActiveChat("text_submit");
      textInput.disabled = true;
      if (sendTextBtn) sendTextBtn.disabled = true;

      let attempt = 0;
      const maxAttempts = 2;
      while (attempt < maxAttempts) {
        try {
          await postRawTextMessage(state.currentChatID, message);
          break;
        } catch (err) {
          if (attempt + 1 < maxAttempts && isServerDesyncError(err)) {
            await handleServerDesync("raw_text_retry");
            setStatus("processing");
            attempt += 1;
            continue;
          }
          throw err;
        }
      }

      textInput.value = "";
      await commitUserMessage(message);
    } catch (err) {
      console.error(err);
      alert("Unable to send message. Please try again.");
      setStatus("error");
    } finally {
      if (!composerLocked) {
        textInput.disabled = false;
        if (sendTextBtn) sendTextBtn.disabled = false;
        textInput.focus();
      }
    }
  }

  // ==============================
  // Buttons / Recording flow
  // ==============================
  async function handleStartToggle() {
    if (composerLocked) return;
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

      // Reset VAD stats for this take (keep calMean from calibration)
      vadStats.peakRms = 0;
      vadStats.activeSpeechMs = 0;

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
    if (composerLocked) return;
    if (!isRecording()) return;

    setButtonsState({ start: true, stop: true });
    setStatus("processing");

    // snapshot when stop is requested so we can compute utterance duration
    const stopCalledAt = performance.now();

    const stopPromise = mediaRecorder._stopPromise;
    mediaRecorder.stop();

    if (activeStream) {
      activeStream.getTracks().forEach((t) => t.stop());
      activeStream = null;
    }

    try {
      const blob = await stopPromise;

      // Duration gate
      const utteranceMs = stopCalledAt - recordingStartedAt;
      if (utteranceMs < MIN_SPEECH_MS) {
        sLog(`Discarding short utterance: ${Math.round(utteranceMs)}ms < ${MIN_SPEECH_MS}ms`);
        setStatus("idle");
        resetRecordingState();
        if (voiceEnabled) resumeRecognitionAfterRecording();
        return;
      }

      // Quality gates (prevent uploading near-silence)
      const peak = vadStats.peakRms || 0;
      const ambient = Math.max(vadStats.calMean || 0, 1e-6);
      const snrDb = 20 * Math.log10(peak / ambient);
      const activeOk = vadStats.activeSpeechMs >= MIN_ACTIVE_SPEECH_MS;
      const peakOk = peak >= MIN_PEAK_RMS;
      const snrOk = snrDb >= MIN_SNR_DB;

      sLog(`VAD quality — peak=${peak.toFixed(4)} snrDb=${snrDb.toFixed(1)} activeMs=${Math.round(vadStats.activeSpeechMs)} (ok? p:${peakOk} snr:${snrOk} act:${activeOk})`);

      if (!(activeOk && peakOk && snrOk)) {
        sLog("Discarding due to failing quality gates (likely silence/noise).");
        setStatus("idle");
        resetRecordingState();
        if (voiceEnabled) resumeRecognitionAfterRecording();
        return;
      }

      const audioBase64 = await blobToBase64(blob);

      await ensureActiveChat("audio_submit");

      const POST_TIMEOUT_MS = 30000;
      const maxPostAttempts = 2;
      let attempt = 0;
      let postRes;

      while (attempt < maxPostAttempts) {
        const ctrl = new AbortController();
        const postTimer = setTimeout(() => ctrl.abort("post_timeout"), POST_TIMEOUT_MS);
        try {
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

        if (postRes?.ok) {
          break;
        }

        const status = postRes?.status;
        const msg = (await postRes?.text()?.catch(() => "")) || "";
        if (attempt + 1 < maxPostAttempts && typeof status === "number" && status >= 500) {
          await handleServerDesync("audio_post_retry");
          setStatus("processing");
          attempt += 1;
          continue;
        }
        const error = new Error(`POST ${STREAM_ROUTE} failed: ${status} ${msg}`);
        error.status = status;
        error.responseText = msg;
        throw error;
      }

      if (!postRes?.ok) {
        const finalError = new Error(`POST ${STREAM_ROUTE} failed after retries`);
        finalError.status = postRes?.status;
        throw finalError;
      }

      forceCloseSSE("audio_submit");
      const { transcript } = await postRes.json();
      const messageText = typeof transcript === "string" ? transcript : "";
      sLog("Transcript from POST:", messageText.slice(0, 160) || "<empty>");

      await commitUserMessage(messageText);
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
        if (typeof data?.text === "string") {
          lastAnswerText = data.text;
        } else if (typeof data?.token === "string") {
          lastAnswerText += data.token;
        }
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
        // ordered enqueue if server sends index
        if (Number.isInteger(data?.index)) {
          enqueueAudioOrdered(data.index, data.ttsDataUrl);
        } else if (data?.ttsDataUrl) {
          enqueueAudio(data.ttsDataUrl);
        }
      });

      es.addEventListener("done", () => {
        setStatus("done");
        end(true, "server_done_event");
      });

      es.addEventListener("error", (e) => {
        const payload = safeParse(e?.data || "");
        if (payload?.message) {
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
    if (!el) return;
    const sliderVal = volumeSlider ? parseFloat(volumeSlider.value) : NaN;
    if (Number.isFinite(sliderVal)) {
      el.volume = Math.min(1, Math.max(0, sliderVal));
    }
    if (dataUrl) {
      el.src = dataUrl;
      el.load();
      el.play().catch(() => {});
    } else {
      el.setAttribute("hidden", "hidden");
      el.removeAttribute("src");
      el.load();
    }
  }
  function setButtonsState({ start, stop }) {
    if (composerLocked) {
      if (startBtn) startBtn.disabled = true;
      if (stopBtn) stopBtn.disabled = true;
      return;
    }
    startBtn && (startBtn.disabled = !!start);
    stopBtn && (stopBtn.disabled = !!stop);
  }
  function setStatus(state) {
    if (!statusEl) return;
    const label = statusLabels[state] ?? statusLabels.idle;
    statusEl.dataset.state = state;
    statusEl.textContent = label;
  }
  function setStatusLabel(text) {
    if (!statusEl) return;
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
