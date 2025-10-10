(() => {
  let mediaRecorder;
  let mediaChunks = [];
  let activeStream = null;

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

  // Initialize UI state
  setStatus("idle");
  updateCardBody(transcriptEl, "");
  updateCardBody(answerEl, "");
  resetRecordingState();

  startBtn.addEventListener("click", handleStartRecording);
  stopBtn.addEventListener("click", handleStopRecording);

  async function handleStartRecording() {
    try {
      activeStream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : undefined;

      mediaRecorder = new MediaRecorder(activeStream, mime ? { mimeType: mime } : undefined);
      mediaChunks = [];
      mediaRecorder.addEventListener("dataavailable", ({ data }) => {
        if (data?.size) {
          mediaChunks.push(data);
        }
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

      mediaRecorder.start();
      setStatus("recording");
      setButtonsState({ start: true, stop: false });

      // Preserve promise for when we stop later
      mediaRecorder._stopPromise = stopPromise;
    } catch (error) {
      console.error(error);
      alert("Microphone permission is required.");
      resetRecordingState();
    }
  }

  async function handleStopRecording() {
    if (!mediaRecorder || mediaRecorder.state !== "recording") {
      return;
    }

    setButtonsState({ start: true, stop: true });
    setStatus("processing");

    const stopPromise = mediaRecorder._stopPromise;
    mediaRecorder.stop();

    // Ensure all tracks are released
    if (activeStream) {
      activeStream.getTracks().forEach((track) => track.stop());
      activeStream = null;
    }

    try {
      const blob = await stopPromise;
      const base64 = await blobToBase64(blob);
      await sendRecording(base64);
      setStatus("done");
    } catch (error) {
      console.error(error);
      alert("Something went wrong.");
      setStatus("error");
    } finally {
      resetRecordingState();
    }
  }

  async function sendRecording(audioBase64) {
    const response = await fetch("/api/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioBase64 }),
    });

    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }

    const data = await response.json();

    updateCardBody(transcriptEl, data?.transcript);
    updateCardBody(answerEl, data?.answer);
    updateAudio(audioEl, data?.ttsDataUrl);
  }

  function updateAudio(el, dataUrl) {
    if (dataUrl) {
      el.src = dataUrl;
      el.removeAttribute("hidden");
      el.load();
      // Attempt autoplay (some browsers may block)
      el.play().catch(() => {
        /* no-op: browser will require manual play */
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

  function resetRecordingState() {
    setButtonsState({ start: false, stop: true });
    mediaRecorder = null;
    mediaChunks = [];
    if (activeStream) {
      activeStream.getTracks().forEach((track) => track.stop());
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
    const chunkSize = 0x8000;

    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }

    return window.btoa(binary);
  }
})();
