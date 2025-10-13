// Immediately Invoked Function Expression (IIFE) to avoid leaking variables into the global scope.
(() => {
  // --- Recording state ---
  let mediaRecorder;
  let mediaChunks = [];
  let activeStream = null;

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

  startBtn.addEventListener("click", handleStartRecording);
  stopBtn.addEventListener("click", handleStopRecording);

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
      setButtonsState({ start: true, stop: false });
    } catch (err) {
      console.error(err);
      alert("Microphone permission is required.");
      resetRecordingState();
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
          "Accept": "application/json",
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
    }
  }

  // ==============================
  // Networking — GET SSE
  // ==============================
  async function openEventStream() {
    sLog("Opening GET SSE:", STREAM_ROUTE);

    await new Promise((resolve, reject) => {
      const es = new EventSource(STREAM_ROUTE, { withCredentials: true });
      let lastAnswerText = "";
      let sawAnyData = false;

      const end = (ok) => {
        try { es.close(); } catch {}
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
      es.addEventListener("Heartbeat", () => { /* keep-alive */ });

      // Server error payloads (e.g., { message: "no_transcript_available" })
      es.addEventListener("error", (e) => {
        // Note: EventSource 'error' is also fired on normal close; handle below
        // If server emits an 'error' *event* with a JSON body, parse it here:
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