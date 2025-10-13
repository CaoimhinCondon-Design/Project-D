// Immediately Invoked Function Expression (IIFE) to avoid leaking variables into the global scope.
(() => {
  // ==============================
  // Config
  // ==============================
  const STREAM_ROUTE = "/api/message/stream"; // POST (transcript) + GET (SSE)

  // Voice detection config
  const FORCE_VAD = false;            // Set true to skip Web Speech and always use VAD
  const VAD_THRESH = 0.08;            // Voice activity RMS threshold (raise if too sensitive)
  const VAD_HANG_MS = 400;            // Hangover to avoid flapping during short pauses
  const AUTO_STOP_SILENCE_MS = 1200;  // If silent this long while recording -> auto stop & send
  const AUTO_STOP_MIN_MS = 500;       // Don't auto-stop before at least this much audio is captured

  // Debug
  const STREAM_DEBUG = true;

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

  // Markdown
  let MD_READY = false;
  let HL_READY = false;

  // ==============================
  // UI refs
  // ==============================
  const startBtn = document.getElementById("startBtn");
  const stopBtn = document.getElementById("stopBtn");
  const statusEl = document.getElementById("status");
  const transcriptEl = document.getElementById("transcript");
  const answerEl = document.getElementById("answer");
  const audioEl = document.getElementById("audio");
  const voiceToggleBtn = document.getElementById("voiceToggle"); // optional

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
  updateCardBody(transcriptEl, "");
  updateCardBody(answerEl, "");
  resetRecordingState();

  startBtn.addEventListener("click", handleStartToggle);
  stopBtn.addEventListener("click", handleStopRecording);
  attachVoiceToggle();

  // ==============================
  // Voice toggle (SR with VAD fallback)
  // ==============================
  function attachVoiceToggle() {
    if (!voiceToggleBtn) return; // if no button present, quietly skip
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
    // Ensure mic permission up-front for better reliability
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      alert("Please allow microphone access to enable Voice mode.");
      return;
    }

    // Always run VAD: it gives us the end-of-speech auto stop
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

    // Stop SR if running
    if (recognition) {
      recognitionManuallyPaused = true;
      try { recognition.stop(); } catch {}
    }

    // Stop VAD if active
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

    // Treat audio start as a user interrupt to begin capture
    recognition.onaudiostart = () => {
      if (!voiceEnabled) return;
      sLog("SR onaudiostart → interrupt AI");
      interruptAI();
      // VAD handles exact start/stop and auto-stop
    };

    recognition.onresult = () => {
      // We rely on VAD for precise timing; SR just wakes/interrupts
    };

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
        if (!voiceEnabled) return; // stop sampling if disabled
        analyser.getFloatTimeDomainData(buf);

        // Compute RMS
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        const now = performance.now();

        // Detect speech start/ongoing
        if (rms > VAD_THRESH) {
          lastSpeechTs = now;
          if (!talking) {
            talking = true;
            sLog("VAD speech start");
            // If AI is speaking/streaming, interrupt and start recording
            interruptAI();
            if (!isRecording()) {
              pauseRecognitionForRecording();
              handleStartRecording().catch((e) => sLog("VAD start recording failed:", e));
            }
          }
        } else {
          // Silence logic / hangover
          if (talking && now - lastSpeechTs > VAD_HANG_MS) {
            talking = false; // consider user paused/finished
          }
        }

        // Auto-stop on sustained silence while recording
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
      lastSpeechTs = performance.now(); // seed so immediate auto-stop doesn't trigger

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
      // Build base64 and POST
      const blob = await stopPromise;
      const audioBase64 = await blobToBase64(blob);

      const postRes = await fetch(STREAM_ROUTE, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Cache-Control": "no-cache",
        },
        credentials: "same-origin",
        body: JSON.stringify({ audioBase64 }),
      });

      if (!postRes.ok) {
        const msg = await postRes.text().catch(() => "");
        throw new Error(`POST ${STREAM_ROUTE} failed: ${postRes.status} ${msg}`);
      }

      const { transcript } = await postRes.json();
      sLog("Transcript from POST:", transcript?.slice(0, 160) || "<empty>");
      await updateCardBody(transcriptEl, transcript || "");
      await updateCardBody(answerEl, "");
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
    sLog("Opening GET SSE:", STREAM_ROUTE);

    await new Promise((resolve, reject) => {
      const es = new EventSource(STREAM_ROUTE, { withCredentials: true });
      currentEventSource = es;
      let lastAnswerText = "";
      let sawAnyData = false;

      const end = (ok) => {
        try { es.close(); } catch {}
        if (currentEventSource === es) currentEventSource = null;
        ok ? resolve() : reject(new Error("SSE error"));
      };

      const handleStatus = (data) => {
        const stage = data?.stage ? ` (${data.stage})` : "";
        setStatusLabel(`Processing${stage}`);
      };

      es.addEventListener("status", (e) => {
        sawAnyData = true;
        handleStatus(safeParse(e.data));
      });

      es.addEventListener("subStatus", (e) => {
        sawAnyData = true;
        handleStatus(safeParse(e.data));
      });

      es.addEventListener("transcript", (e) => {
        sawAnyData = true;
        const data = safeParse(e.data);
        if (data?.transcript) scheduleMarkdownUpdate(transcriptEl, data.transcript);
      });

      es.addEventListener("token", (e) => {
        sawAnyData = true;
        const data = safeParse(e.data);
        if (typeof data?.text === "string") {
          lastAnswerText = data.text;
        } else if (typeof data?.token === "string") {
          lastAnswerText += data.token;
        }
        scheduleMarkdownUpdate(answerEl, lastAnswerText);
      });

      es.addEventListener("answer", (e) => {
        sawAnyData = true;
        const data = safeParse(e.data);
        lastAnswerText = data?.answer || lastAnswerText;
        scheduleMarkdownUpdate(answerEl, lastAnswerText);
      });

      es.addEventListener("finishedParagraph", (e) => {
        sawAnyData = true;
        const data = safeParse(e.data);
        if (data?.ttsDataUrl) enqueueAudio(data.ttsDataUrl); // data:audio/mpeg;base64,...
      });

      // Server heartbeat
      es.addEventListener("Heartbeat", () => {});

      // Server error payloads (e.g., { message: "no_transcript_available" })
      es.addEventListener("error", (e) => {
        const payload = safeParse(e?.data || "");
        if (payload?.message) {
          scheduleMarkdownUpdate(answerEl, `**Error:** ${payload.message}`);
          setStatus("error");
          end(false);
        }
      });

      // Connection close: EventSource sets onerror when the stream ends.
      es.onerror = () => {
        if (sawAnyData) {
          setStatus("done");
          end(true);
        } else {
          setStatus("error");
          end(false);
        }
      };
    });
  }

  // ==============================
  // Interrupt logic
  // ==============================
  function interruptAI() {
    if (interrupting) return;
    interrupting = true;

    // Stop any TTS in progress and clear queue
    try {
      audioQueue.length = 0;
      if (!audioEl.paused) audioEl.pause();
      updateAudio(audioEl, null);
      audioPlaying = false;
    } catch {}

    // Close any live SSE stream
    if (currentEventSource) {
      try { currentEventSource.close(); } catch {}
      currentEventSource = null;
    }

    // UI nudge to show we're switching to user
    setStatusLabel("Listening…");

    // If we were already recording, leave it; otherwise start recording
    if (!isRecording()) {
      if (voiceEnabled) pauseRecognitionForRecording();
      handleStartRecording().finally(() => {
        interrupting = false;
      });
    } else {
      interrupting = false;
    }
  }

  // ==============================
  // Markdown support
  // ==============================
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error("Failed to load " + src));
      document.head.appendChild(s);
    });
  }

  async function ensureMarkdown() {
    if (MD_READY) return;
    if (!window.marked) {
      await loadScript("https://cdn.jsdelivr.net/npm/marked/marked.min.js");
    }
    if (!window.DOMPurify) {
      await loadScript("https://cdn.jsdelivr.net/npm/dompurify@3.0.6/dist/purify.min.js");
    }
    if (window.marked) {
      marked.setOptions({
        breaks: true,
        gfm: true,
        mangle: false,
        headerIds: true
      });
    }
    MD_READY = true;
  }

  async function ensureHighlighting() {
    if (HL_READY) return;
    if (!window.hljs) {
      await loadScript("https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/lib/common.min.js");
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github.min.css";
      document.head.appendChild(link);
    }
    HL_READY = true;
  }

  async function renderMarkdown(el, mdText) {
    await ensureMarkdown();
    const html = DOMPurify.sanitize(marked.parse(mdText || ""));
    // since your elements are <pre>, make them behave like blocks
    el.style.whiteSpace = "normal";
    el.style.fontFamily = "inherit";
    el.innerHTML = html;

    // code highlighting
    await ensureHighlighting();
    el.querySelectorAll("pre code").forEach(block => {
      try { hljs.highlightElement(block); } catch {}
    });
  }

  // Throttle streaming paints
  let mdPaintScheduled = false;
  function scheduleMarkdownUpdate(el, text) {
    if (mdPaintScheduled) return;
    mdPaintScheduled = true;
    requestAnimationFrame(async () => {
      mdPaintScheduled = false;
      await updateCardBody(el, text);
    });
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

  async function updateCardBody(element, value) {
    const text = typeof value === "string" ? value.trim() : "";
    const isTranscript = element.id === "transcript";
    const placeholder = isTranscript ? "Waiting for transcript..." : "Waiting for answer...";

    if (text.length === 0) {
      element.dataset.empty = "true";
      element.textContent = placeholder;
    } else {
      element.dataset.empty = "false";
      await renderMarkdown(element, text);
      flashCard(element.closest(".card"));
    }
  }

  function flashCard(card) {
    if (!card) return;
    card.classList.add("card--active");
    window.setTimeout(() => card.classList.remove("card--active"), 900);
  }

  async function blobToBase64(blob) {
    const buffer = await blob.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000; // 32KB
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return window.btoa(binary);
  }
})();
