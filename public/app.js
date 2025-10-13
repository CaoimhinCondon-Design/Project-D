// Immediately Invoked Function Expression (IIFE) to avoid leaking variables into the global scope.
(() => {
  // --- Recording state ---
  let mediaRecorder;
  let mediaChunks = [];
  let activeStream = null;

  // --- Event stream / interrupt state (NEW) ---
  let currentEventSource = null;
  let interrupting = false;

  // --- Speech / VAD configuration (NEW) ---
  // Force the VAD fallback and skip Web Speech entirely (set true if you just want it working now)
  const FORCE_VAD = false;

  // Web Speech state
  let recognition = null;
  let recognitionRunning = false;
  let recognitionManuallyPaused = false;
  let vadStopFn = null; // fallback VAD stopper

  // SR error handling
  let srNetworkErrorCount = 0;
  const SR_NETWORK_ERROR_LIMIT = 3;        // after 3 consecutive network errors…
  const SR_ERROR_WINDOW_MS = 5000;         // …within this window
  let srErrorWindowStart = 0;

  // --- Debug helper ---
  const STREAM_DEBUG = true;
  function sLog(...args) {
    if (!STREAM_DEBUG) return;
    const ts = new Date().toISOString();
    console.log(`[stream ${ts}]`, ...args);
  }

  // --- Endpoints ---
  const STREAM_ROUTE = "/api/message/stream"; // POST (transcript) + GET (SSE)

  // --- UI refs ---
  const startBtn = document.getElementById("startBtn");
  const stopBtn = document.getElementById("stopBtn");
  const statusEl = document.getElementById("status");
  const transcriptEl = document.getElementById("transcript");
  const answerEl = document.getElementById("answer");
  const audioEl = document.getElementById("audio");
  const voiceToggleBtn = document.getElementById("voiceToggle"); // optional

  const placeholders = {
    transcript: "Waiting for transcript...",
    answer: "Waiting for answer...",
  };

  const statusLabels = {
    idle: "Idle",
    recording: "Recording...",
    processing: "Processing...",
    done: "Done",
    error: "Error",
  };

  // --- Audio queue for TTS clips ---
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
    audioEl.play().catch(() => {
      // Some browsers require a user gesture first.
    });
  }

  audioEl.addEventListener("ended", () => {
    audioPlaying = false;
    maybePlayNext();
  });

  // --- Init UI ---
  setStatus("idle");
  updateCardBody(transcriptEl, "");
  updateCardBody(answerEl, "");
  resetRecordingState();

  // Start is now a toggle: start or cancel recording
  startBtn.addEventListener("click", handleStartToggle);
  stopBtn.addEventListener("click", handleStopRecording);

  // ==============================
  // Voice detection setup (SR with auto-fallback to VAD)
  // ==============================
  setupSpeechDetection();

  function setupSpeechDetection() {
    if (FORCE_VAD) {
      sLog("FORCE_VAD enabled → starting VAD fallback");
      startVADFallback();
      uiMarkVoiceOn("(VAD)");
      return;
    }

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      sLog("SpeechRecognition not available; starting VAD fallback");
      startVADFallback();
      uiMarkVoiceOn("(VAD)");
      return;
    }

    initSpeechRecognition(SR);
    safeStartRecognition();
    uiMarkVoiceOn("(SR)");
  }

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
      if (!recognitionManuallyPaused) {
        setTimeout(safeStartRecognition, 600);
      }
    };

    // Fired when speech is detected — this is our "wake"
    recognition.onaudiostart = () => {
      sLog("SpeechRecognition detected audio start → interrupt AI");
      interruptAI(); // closes SSE + pauses TTS
    };

    recognition.onresult = (event) => {
      const res = event.results?.[event.results.length - 1];
      const transcript = res?.[0]?.transcript?.trim() ?? "";
      sLog("SpeechRecognition result:", transcript);

      // Pause while we capture mic for MediaRecorder flow
      pauseRecognitionForRecording();

      if (!mediaRecorder || mediaRecorder.state !== "recording") {
        handleStartRecording()
          .catch((err) => sLog("Start recording failed:", err))
          .finally(() => {
            // If recording didn’t start, resume SR so user can try again
            if (!mediaRecorder || mediaRecorder.state !== "recording") {
              resumeRecognitionAfterRecording();
            }
          });
      }
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
        if (srNetworkErrorCount >= SR_NETWORK_ERROR_LIMIT) {
          sLog("Persistent SR network errors → switching to VAD");
          recognitionManuallyPaused = true;
          try { recognition.stop(); } catch {}
          startVADFallback();
          uiMarkVoiceOn("(VAD)");
        }
      }

      if (err === "not-allowed" || err === "service-not-allowed") {
        recognitionManuallyPaused = true;
        try { recognition.stop(); } catch {}
        startVADFallback();
        uiMarkVoiceOn("(VAD)");
      }
    };

    // Keep it alive across tab visibility changes
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !recognitionManuallyPaused) {
        safeStartRecognition();
      }
    });
  }

  function safeStartRecognition() {
    if (!recognition || recognitionRunning) return;
    try { recognition.start(); } catch (e) {
      // Thrown if already started; safe to ignore.
    }
  }

  function pauseRecognitionForRecording() {
    if (!recognition) return;
    recognitionManuallyPaused = true;
    if (recognitionRunning) {
      try { recognition.stop(); } catch {}
    }
  }

  function resumeRecognitionAfterRecording() {
    if (!recognition) return;
    recognitionManuallyPaused = false;
    safeStartRecognition();
  }

  // Minimal UI helper (optional)
  function uiMarkVoiceOn(mode) {
    if (!voiceToggleBtn) return;
    voiceToggleBtn.disabled = true;
    voiceToggleBtn.textContent = `🎙️ Voice On ${mode || ""}`;
  }

  // ==============================
  // VAD fallback (Web Audio) — works everywhere with getUserMedia
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
      let talking = false;
      let lastSpeechTs = 0;

      const THRESH = 0.02;   // adjust if too sensitive / not sensitive enough
      const HANG_MS = 400;   // hangover to avoid flapping

      sLog("VAD fallback running");
      let rafId = 0;

      function loop() {
        analyser.getFloatTimeDomainData(buf);
        // compute RMS
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const x = buf[i];
          sum += x * x;
        }
        const rms = Math.sqrt(sum / buf.length);

        const now = performance.now();
        if (rms > THRESH) {
          lastSpeechTs = now;
          if (!talking) {
            talking = true;
            sLog("VAD speech start → interrupt & start recording");
            interruptAI();
            if (!mediaRecorder || mediaRecorder.state !== "recording") {
              handleStartRecording().catch((e) => sLog("VAD start recording failed:", e));
            }
          }
        } else if (talking && now - lastSpeechTs > HANG_MS) {
          talking = false;
          sLog("VAD speech end");
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
      sLog("VAD fallback failed to init:", e);
    }
  }

  // ==============================
  // Start button toggle (Start/Cancel)
  // ==============================
  async function handleStartToggle() {
    // Pause any currently playing audio when Start is clicked
    try {
      if (audioEl && !audioEl.paused) audioEl.pause();
    } catch {}

    // If currently recording, treat Start as "cancel"
    if (mediaRecorder && mediaRecorder.state === "recording") {
      await cancelRecording();
      return;
    }

    // Otherwise begin a fresh recording
    pauseRecognitionForRecording();
    await handleStartRecording();
  }

  // ==============================
  // Cancel recording — discard audio, no POST/SSE
  // ==============================
  async function cancelRecording() {
    sLog("Cancelling recording via Start toggle");

    // UI: back to idle
    setStatus("idle");
    setButtonsState({ start: false, stop: true });

    // Stop the MediaRecorder without using _stopPromise (we're discarding)
    try {
      if (mediaRecorder && mediaRecorder.state === "recording") {
        mediaRecorder.stop();
      }
    } catch {}

    // Stop mic tracks
    if (activeStream) {
      try {
        activeStream.getTracks().forEach((t) => t.stop());
      } catch {}
      activeStream = null;
    }

    // Clear state
    mediaRecorder = null;
    mediaChunks = [];

    // Resume hands-free listening
    resumeRecognitionAfterRecording();
  }

  // ==============================
  // Recording
  // ==============================
  async function handleStartRecording() {
    try {
      activeStream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : undefined;

      mediaRecorder = new MediaRecorder(activeStream, mime ? { mimeType: mime } : undefined);
      mediaChunks = [];

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
      setButtonsState({ start: true, stop: false }); // disable Start, enable Stop
    } catch (err) {
      console.error(err);
      alert("Microphone permission is required.");
      resetRecordingState();
      // If we failed to start recording, resume the wake listener
      resumeRecognitionAfterRecording();
    }
  }

  async function handleStopRecording() {
    if (!mediaRecorder || mediaRecorder.state !== "recording") return;

    setButtonsState({ start: true, stop: true });
    setStatus("processing");

    const stopPromise = mediaRecorder._stopPromise;
    mediaRecorder.stop();

    if (activeStream) {
      activeStream.getTracks().forEach((t) => t.stop());
      activeStream = null;
    }

    try {
      // 1) Build base64 from recorded blob
      const blob = await stopPromise;
      const audioBase64 = await blobToBase64(blob);

      // 2) POST audio → get written transcript (NO SSE here)
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
      sLog("Transcript received from POST:", transcript?.slice(0, 160) || "<empty>");
      updateCardBody(transcriptEl, transcript || "");
      updateCardBody(answerEl, "");
      audioQueue.length = 0;
      audioPlaying = false;
      updateAudio(audioEl, null);

      // 3) GET SSE stream for reasoning + TTS
      await openEventStream();
      setStatus("done");
    } catch (err) {
      console.error(err);
      alert("Something went wrong while sending/streaming.");
      setStatus("error");
    } finally {
      resetRecordingState();
      // After we finish a full request/response cycle, resume the wake listener
      resumeRecognitionAfterRecording();
    }
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
        try {
          es.close();
        } catch {}
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
        if (data?.transcript) updateCardBody(transcriptEl, data.transcript);
      });

      es.addEventListener("token", (e) => {
        sawAnyData = true;
        const data = safeParse(e.data);
        if (typeof data?.text === "string") {
          lastAnswerText = data.text;
        } else if (typeof data?.token === "string") {
          lastAnswerText += data.token;
        }
        updateCardBody(answerEl, lastAnswerText);
      });

      es.addEventListener("answer", (e) => {
        sawAnyData = true;
        const data = safeParse(e.data);
        lastAnswerText = data?.answer || lastAnswerText;
        updateCardBody(answerEl, lastAnswerText);
      });

      es.addEventListener("finishedParagraph", (e) => {
        sawAnyData = true;
        const data = safeParse(e.data);
        if (data?.ttsDataUrl) enqueueAudio(data.ttsDataUrl); // data:audio/mpeg;base64,...
      });

      // Server heartbeat
      es.addEventListener("Heartbeat", () => {
        /* keep-alive */
      });

      // Server error payloads (e.g., { message: "no_transcript_available" })
      es.addEventListener("error", (e) => {
        // Note: EventSource 'error' is also fired on normal close; handle below
        const payload = safeParse(e?.data || "");
        if (payload?.message) {
          updateCardBody(answerEl, `Error: ${payload.message}`);
          setStatus("error");
          end(false);
        }
      });

      // Connection close: EventSource sets onerror when the stream ends.
      es.onerror = () => {
        // If we saw any frames, consider this a clean end; else raise an error.
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
  // Interrupt logic (NEW)
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
    if (!mediaRecorder || mediaRecorder.state !== "recording") {
      pauseRecognitionForRecording();
      handleStartRecording().finally(() => {
        interrupting = false;
      });
    } else {
      interrupting = false;
    }
  }

  // ==============================
  // Helpers
  // ==============================
  function safeParse(s) {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }

  function updateAudio(el, dataUrl) {
    if (dataUrl) {
      el.src = dataUrl;
      el.removeAttribute("hidden");
      el.load();
      el.play().catch(() => {
        // Autoplay may require a user gesture first.
      });
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
    if (activeStream) {
      activeStream.getTracks().forEach((t) => t.stop());
      activeStream = null;
    }
  }

  function updateCardBody(element, value) {
    const text = typeof value === "string" ? value.trim() : "";
    const isTranscript = element.id === "transcript";
    const placeholder = isTranscript ? placeholders.transcript : placeholders.answer;

    if (text.length === 0) {
      element.dataset.empty = "true";
      element.textContent = placeholder;
    } else {
      element.dataset.empty = "false";
      element.textContent = value;
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
