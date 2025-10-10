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

      mediaRecorder.start();
      setStatus("recording");
      setButtonsState({ start: true, stop: false });

      mediaRecorder._stopPromise = stopPromise;
    } catch (error) {
      console.error(error);
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

    // ensure all tracks are released
    if (activeStream) {
      activeStream.getTracks().forEach((t) => t.stop());
      activeStream = null;
    }

    try {
      const blob = await stopPromise;
      const base64 = await blobToBase64(blob);
      await sendRecordingStreamed(base64);
      setStatus("done");
    } catch (error) {
      console.error(error);
      alert("Something went wrong.");
      setStatus("error");
    } finally {
      resetRecordingState();
    }
  }

  /**
   * Posts audio and consumes SSE from /api/message/stream (repo default),
   * with a fallback to JSON /api/message for legacy behavior.
   *
   * Current backend events (today): status, transcript, token, answer, summary, speech, done, error
   * Upcoming events: subStatus, finishedParagraph, token, answer
   */
  async function sendRecordingStreamed(audioBase64) {
    // reset UI for a new run
    updateCardBody(transcriptEl, "");
    updateCardBody(answerEl, "");
    answerEl._streaming = true;
    answerEl.textContent = "";
    transcriptEl._lastText = "";

    const streamResp = await fetch("/api/message/stream", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "text/event-stream"
      },
      body: JSON.stringify({ audioBase64, stream: true })
    });

    if (!streamResp.ok) throw new Error(`Request failed with status ${streamResp.status}`);

    const ct = streamResp.headers.get("content-type") || "";
    if (!streamResp.body || !ct.includes("text/event-stream")) {
      // Fallback to old JSON endpoint
      const jsonResp = await fetch("/api/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audioBase64 })
      });
      if (!jsonResp.ok) throw new Error(`Request failed with status ${jsonResp.status}`);
      const data = await jsonResp.json();
      updateCardBody(transcriptEl, data?.transcript);
      updateCardBody(answerEl, data?.answer);
      updateAudio(audioEl, data?.ttsDataUrl || data?.speech);
      return;
    }

    const reader = streamResp.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // process complete SSE events (separated by blank line)
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        dispatchSSE(parseSSE(rawEvent));
      }
    }

    // trailing chunk (no final newline)
    if (buffer.trim().length) {
      dispatchSSE(parseSSE(buffer));
    }

    answerEl._streaming = false;
    flashCard(answerEl.closest(".card"));
    setStatus("done");
  }

  // --- SSE handling ---

  function dispatchSSE(evt) {
    if (!evt) return;
    const { event, data } = evt;

    switch (event) {
      // --- current repo events (per README) ---
      case "status": {
        // { stage: "transcribing" | "reasoning" | "summarizing" | "speaking" }
        onSubStatus({ stage: data?.stage });
        break;
      }
      case "transcript": {
        // data is a string transcript
        updateCardBody(transcriptEl, typeof data === "string" ? data : "");
        break;
      }
      case "token": {
        onToken(data); // { token, text? }
        break;
      }
      case "answer": {
        onAnswer(data); // { answer } or string in current impl
        break;
      }
      case "summary": {
        // data is short summary string
        onFinishedParagraph({ shortSummary: typeof data === "string" ? data : "", index: 0 });
        break;
      }
      case "speech": {
        // data is dataUrl
        updateAudio(audioEl, typeof data === "string" ? data : "");
        break;
      }
      case "done": {
        setStatus("done");
        break;
      }
      case "error": {
        setStatus("error");
        break;
      }

      // --- upcoming backend event names ---
      case "subStatus": {
        onSubStatus(data); // { stage }
        break;
      }
      case "finishedParagraph": {
        onFinishedParagraph(data); // { ttsDataUrl, shortSummary, index }
        break;
      }

      // --- generic fallback ---
      default: {
        // No-op; unknown event types are ignored
      }
    }
  }

  function onSubStatus(payload) {
    const stage = payload?.stage || "";
    statusEl.dataset.state = "processing";
    statusEl.textContent = `${statusLabels.processing}${stage ? ` – ${stage}` : ""}`;
  }

  function onFinishedParagraph(payload) {
    const { ttsDataUrl, shortSummary, index } = payload || {};
    const existing = (transcriptEl.textContent || "").trim();
    const prefix = existing && existing !== placeholders.transcript ? existing + "\n" : "";
    const line = typeof shortSummary === "string" ? `Paragraph ${Number(index ?? 0) + 1}: ${shortSummary.trim()}` : "";
    const next = (prefix + line).trim();
    updateCardBody(transcriptEl, next);

    if (ttsDataUrl) updateAudio(audioEl, ttsDataUrl);
  }

  function onToken(payload) {
    // supports both { token, text } and raw token strings
    const token = typeof payload === "string" ? payload : payload?.token;
    const text = typeof payload === "object" ? payload?.text : undefined;

    if (typeof token === "string" && token.length) {
      answerEl.dataset.empty = "false";
      answerEl.textContent += token;
    }
    if (typeof text === "string") {
      transcriptEl._lastText = text;
      updateCardBody(transcriptEl, text);
    }
  }

  function onAnswer(payload) {
    // supports { answer } or a raw string
    const finalAnswer = typeof payload === "string" ? payload : payload?.answer;
    if (typeof finalAnswer === "string") {
      updateCardBody(answerEl, finalAnswer);
    }
  }

  // --- UI helpers (unchanged) ---

  function updateAudio(el, dataUrl) {
    if (dataUrl) {
      el.src = dataUrl;
      el.removeAttribute("hidden");
      el.load();
      el.play().catch(() => { /* autoplay may be blocked */ });
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
      element.textContent = text;
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

  // Minimal SSE block parser: returns { event, data } with JSON-parsed data when possible.
  function parseSSE(block) {
    const lines = block.split(/\r?\n/).filter(Boolean);
    if (!lines.length) return null;

    let event = "message";
    let dataRaw = "";

    for (const line of lines) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        const chunk = line.slice(5).trim();
        dataRaw += (dataRaw ? "\n" : "") + chunk; // allow multi-line data
      }
    }

    let data = dataRaw;
    try {
      data = JSON.parse(dataRaw);
    } catch {
      // keep string as-is
    }
    return { event, data };
  }
})();
