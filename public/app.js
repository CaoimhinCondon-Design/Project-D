// Immediately Invoked Function Expression (IIFE) to avoid leaking variables into the global scope.
(() => {
  // --- Recording state ---
  // MediaRecorder instance used to capture audio from the user's microphone.
  let mediaRecorder;
  // Chunks of recorded audio data that will be combined into a single Blob on stop.
  let mediaChunks = [];
  // The active MediaStream (microphone input) so we can stop and release tracks.
  let activeStream = null;

  // --- Debug helper for uniform, timestamped logs ---
  const STREAM_DEBUG = true;
  function sLog(...args) {
    if (!STREAM_DEBUG) return;
    const ts = new Date().toISOString();
    console.log(`[stream ${ts}]`, ...args);
  }


  // --- UI element references ---
  const startBtn = document.getElementById("startBtn");
  const stopBtn = document.getElementById("stopBtn");
  const statusEl = document.getElementById("status");
  const transcriptEl = document.getElementById("transcript");
  const answerEl = document.getElementById("answer");
  const audioEl = document.getElementById("audio");

  // Placeholders shown in the transcript/answer cards when they are empty.
  const placeholders = {
    transcript: "Waiting for transcript...",
    answer: "Waiting for answer...",
  };

  // Labels for the status pill at the top of the UI.
  const statusLabels = {
    idle: "Idle",
    recording: "Recording...",
    processing: "Processing...",
    done: "Done",
    error: "Error",
  };

  // --- Audio playback queue for TTS clips ---
  // The server may send multiple paragraph TTS clips; queue them to play in order.
  const audioQueue = [];
  // Whether the audio element is currently playing a clip.
  let audioPlaying = false;

  /**
   * Enqueue a TTS data URL returned by the server and try to start playback.
   * @param {string} dataUrl - A data:audio/mpeg;base64,... URL to play.
   */
  function enqueueAudio(dataUrl) {
    if (!dataUrl) return;
    audioQueue.push(dataUrl);
    maybePlayNext();
  }

  /**
   * If no audio is currently playing, start the next clip in the queue.
   */
  function maybePlayNext() {
    if (audioPlaying) return;
    const next = audioQueue.shift();
    if (!next) return;
    audioPlaying = true;
    updateAudio(audioEl, next);
    // Attempt autoplay; some browsers may block until a user gesture occurs.
    audioEl.play().catch(() => {});
  }

  // When a clip finishes, mark not playing and check if another clip should start.
  audioEl.addEventListener("ended", () => {
    audioPlaying = false;
    maybePlayNext();
  });

  // --- Initial UI setup ---
  // Status pill shows "Idle"; transcript/answer cards are cleared to placeholders.
  setStatus("idle");
  updateCardBody(transcriptEl, "");
  updateCardBody(answerEl, "");
  // Disable/enable buttons & ensure prior media tracks are released.
  resetRecordingState();

  // Button handlers for starting/stopping a recording session.
  startBtn.addEventListener("click", handleStartRecording);
  stopBtn.addEventListener("click", handleStopRecording);

  /**
   * Request microphone access, set up a MediaRecorder, and begin recording.
   * Captures chunks in `mediaChunks` and stores a promise that resolves to a Blob on stop.
   */
  async function handleStartRecording() {
    try {
      // Request microphone input from the browser.
      activeStream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Use Opus-in-WebM if supported for efficient speech recording.
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : undefined;

      // Create the MediaRecorder with the supported (or default) mime type.
      mediaRecorder = new MediaRecorder(activeStream, mime ? { mimeType: mime } : undefined);
      mediaChunks = [];
      // Collect recorded chunks as they become available.
      mediaRecorder.addEventListener("dataavailable", ({ data }) => {
        if (data?.size) mediaChunks.push(data);
      });

      // Promise resolves with a single Blob that merges all chunks once `stop()` fires.
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

      // Start recording and update UI state.
      mediaRecorder.start();
      setStatus("recording");
      setButtonsState({ start: true, stop: false });

      // Store the promise so the stop handler can await the final Blob.
      mediaRecorder._stopPromise = stopPromise;
    } catch (error) {
      // If user rejects mic permissions (or device lacks a mic), show a friendly message.
      console.error(error);
      alert("Microphone permission is required.");
      resetRecordingState();
    }
  }

  /**
   * Stop the recording session, convert the audio Blob to base64, and
   * POST it to the streaming endpoint. UI status transitions to "processing"
   * while the server streams SSE events back to the client.
   */
  async function handleStopRecording() {

    console.log("handleStopRecording called")
    // If not recording, nothing to do.
    if (!mediaRecorder || mediaRecorder.state !== "recording") return;

    // Disable both buttons while we process the audio.
    setButtonsState({ start: true, stop: true });
    setStatus("processing");

    // Grab the stop promise set up in the start handler, then stop recording.
    const stopPromise = mediaRecorder._stopPromise;
    mediaRecorder.stop();

    // Always release the microphone tracks to free the device immediately.
    if (activeStream) {
      activeStream.getTracks().forEach((track) => track.stop());
      activeStream = null;
    }

    try {
      // Wait for the recorder to finish and yield a single audio Blob.
      const blob = await stopPromise;
      // Convert the audio clip to a base64 string to send via JSON.
      const base64 = await blobToBase64(blob);
      // Instead of a non-streaming POST, call the streaming version (SSE over fetch).
      await streamRecording(base64);
      setStatus("done");
    } catch (error) {
      console.error(error);
      alert("Something went wrong.");
      setStatus("error");
    } finally {
      // Restore UI controls to ready state for another run.
      resetRecordingState();
    }
  }

  /**
   * Stream tokens & events from /api/message/stream via POST + ReadableStream.
   * Because EventSource doesn't support POST, we implement a tiny SSE parser
   * that understands `event:` and `data:` lines and updates the UI accordingly.
   *
   * The server sends multiple event types:
   * - "status":        high-level stage transitions (e.g., transcribing, reasoning)
   * - "subStatus":     finer-grained stage updates (e.g., processing paragraph X)
   * - "transcript":    full transcript text from Whisper
   * - "token":         incremental model output (includes full-so-far `text`)
   * - "answer":        final completed answer
   * - "finishedParagraph": paragraph-level short TTS + summary
   * - "error":         error messages from the server
   */
  async function streamRecording(audioBase64) {
    const runId = Math.random().toString(36).slice(2, 8); // correlate logs per run
    try {
      sLog(runId, "BEGIN streamRecording");

      // Reset UI/audio
      sLog(runId, "Reset UI: clearing transcript/answer & audio queue");
      updateCardBody(transcriptEl, "");
      updateCardBody(answerEl, "");
      audioQueue.length = 0;
      audioPlaying = false;
      updateAudio(audioEl, null);

      const controller = new AbortController();
      const { signal } = controller;

      sLog(runId, "Issuing fetch to /api/message/stream with POST body length:", audioBase64?.length ?? 0);
      const resp = await fetch("/api/message/stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "text/event-stream",
          "Cache-Control": "no-cache",
          "Pragma": "no-cache"
        },
        body: JSON.stringify({ audioBase64 }),
        signal,
        cache: "no-store",
        credentials: "same-origin",
      });

      sLog(runId, "Fetch resolved. Status:", resp.status, "OK?:", resp.ok, "Has body?:", !!resp.body);

      if (!resp.ok || !resp.body) {
        const text = (await resp.text().catch(() => "")) || "<no body>";
        sLog(runId, "Non-OK response or missing body. Status text/body:", text.slice(0, 500));
        throw new Error(`Stream request failed with status ${resp.status}`);
      }

      // Optional: log response headers
      try {
        const hdrs = {};
        resp.headers.forEach((v, k) => (hdrs[k] = v));
        sLog(runId, "Response headers:", hdrs);
      } catch { /* ignore */ }

      const reader = resp.body.getReader();
      const textDecoder = new TextDecoder("utf-8");
      let buffer = "";
      let lastAnswerText = "";
      let totalBytes = 0;
      let framesSeen = 0;
      let firstChunk = true;

      sLog(runId, "Starting read loop…");
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          sLog(runId, "ReadableStream done = true (server closed stream).");
          break;
        }
        const chunkLen = value?.byteLength ?? 0;
        totalBytes += chunkLen;
        if (firstChunk) {
          sLog(runId, "First chunk arrived. byteLength:", chunkLen);
          firstChunk = false;
        } else {
          sLog(runId, "Chunk arrived. byteLength:", chunkLen, "totalBytes:", totalBytes);
        }

        buffer += textDecoder.decode(value, { stream: true });
        sLog(runId, "Buffer length after decode:", buffer.length);

        // Parse complete SSE frames separated by double-newline.
        let idx;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const rawEvent = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          framesSeen += 1;
          sLog(runId, `Frame #${framesSeen} (len=${rawEvent.length})`);

          const { event, data } = parseSSEBlock(rawEvent);
          sLog(runId, `Parsed frame #${framesSeen} → event:`, event, "data:", data);

          if (!event) {
            sLog(runId, `Frame #${framesSeen} has no event; skipping.`);
            continue;
          }

          switch (event) {
            case "status": {
              const stage = data?.stage ? ` (${data.stage})` : "";
              sLog(runId, `UI status → Processing${stage}`);
              setStatusLabel(`Processing${stage}`);
              break;
            }
            case "subStatus": {
              const stage = data?.stage ? ` (${data.stage})` : "";
              sLog(runId, `UI subStatus → Processing${stage}`);
              setStatusLabel(`Processing${stage}`);
              break;
            }
            case "transcript": {
              const text = data?.transcript || "";
              sLog(runId, "Updating transcriptEl with text len:", text.length);
              updateCardBody(transcriptEl, text);
              break;
            }
            case "token": {
              if (typeof data?.text === "string") {
                lastAnswerText = data.text;
                sLog(runId, "Token event with full text. answer len:", lastAnswerText.length);
              } else if (typeof data?.token === "string") {
                lastAnswerText += data.token;
                sLog(runId, "Token event (incremental). token len:", data.token.length, "answer len:", lastAnswerText.length);
              } else {
                sLog(runId, "Token event with no 'text' or 'token' field.");
              }
              updateCardBody(answerEl, lastAnswerText);
              break;
            }
            case "answer": {
              lastAnswerText = data?.answer || lastAnswerText;
              sLog(runId, "Final answer event. answer len:", lastAnswerText.length);
              updateCardBody(answerEl, lastAnswerText);
              break;
            }
            case "finishedParagraph": {
              const hasTTS = !!data?.ttsDataUrl;
              sLog(runId, "finishedParagraph:", { hasTTS, index: data?.index, shortSummaryLen: (data?.shortSummary || "").length });
              if (data?.ttsDataUrl) {
                enqueueAudio(data.ttsDataUrl);
                sLog(runId, "Enqueued TTS audio. Queue size now:", audioQueue.length);
              }
              break;
            }
            case "error": {
              sLog(runId, "Server error event:", data?.message);
              setStatus("error");
              break;
            }
            default: {
              sLog(runId, "Unknown event type; ignoring:", event);
              break;
            }
          }
        }
      }

      // After loop ends (server closed stream)
      sLog(runId, "Read loop finished. totalBytes:", totalBytes, "framesSeen:", framesSeen);
      setStatus("done");
      sLog(runId, "END streamRecording (success)");
    } catch (err) {
      sLog(runId, "streamRecording caught error");
      console.error("[streamRecording] failed:", err);
      setStatus("error");
    }
  }

  // --- Helpers ---

  /**
   * Parse a single SSE event block (text between blank lines).
   * Supports lines like:
   *   event: token
   *   data: {"token":"...","text":"..."}
   * Returns { event: string|null, data: any|null }.
   */
  function parseSSEBlock(block) {
    let event = null;
    let data = null;

    // Each block may include multiple lines; we scan for "event:" and "data:" prefixes.
    const lines = block.split("\n");
    for (const line of lines) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        const jsonStr = line.slice(5).trim();
        try {
          data = JSON.parse(jsonStr);
        } catch {
          // If JSON is malformed, keep data as null to avoid exceptions.
          data = null;
        }
      }
    }
    return { event, data };
  }

  /**
   * Update the <audio> element with a new data URL or hide it if null.
   * Also attempts autoplay; some browsers require a user gesture first.
   */
  function updateAudio(el, dataUrl) {
    if (dataUrl) {
      el.src = dataUrl;
      el.removeAttribute("hidden");
      el.load();
      el.play().catch(() => {
        /* browser may require user gesture */
      });
    } else {
      el.setAttribute("hidden", "hidden");
      el.removeAttribute("src");
      el.load();
    }
  }

  /**
   * Enable/disable the Start and Stop buttons.
   * Pass booleans; true means "disabled".
   * Example: setButtonsState({ start: true, stop: false }) disables Start, enables Stop.
   */
  function setButtonsState({ start, stop }) {
    startBtn.disabled = !!start;
    stopBtn.disabled = !!stop;
  }

  /**
   * Set the status pill to a named state (idle, recording, processing, done, error).
   */
  function setStatus(state) {
    const label = statusLabels[state] ?? statusLabels.idle;
    statusEl.dataset.state = state;
    statusEl.textContent = label;
  }

  /**
   * Set a free-form status label (keeps the dataset state as "processing").
   * Useful for displaying server-reported stage names (e.g., "(transcribing)").
   */
  function setStatusLabel(text) {
    statusEl.dataset.state = "processing";
    statusEl.textContent = text;
  }

  /**
   * Reset UI controls and release any active microphone stream.
   * Called initially and after each run to return the app to a ready state.
   */
  function resetRecordingState() {
    setButtonsState({ start: false, stop: true });
    mediaRecorder = null;
    mediaChunks = [];
    if (activeStream) {
      activeStream.getTracks().forEach((track) => track.stop());
      activeStream = null;
    }
  }

  /**
   * Update a <pre> card body with new text and toggle its "empty" placeholder state.
   * Also triggers a brief CSS pulse (flashCard) on update to draw the user's eye.
   */
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

  /**
   * Briefly add a CSS class to the card to animate a "flash" effect on change.
   */
  function flashCard(card) {
    if (!card) return;
    card.classList.add("card--active");
    window.setTimeout(() => card.classList.remove("card--active"), 900);
  }

  /**
   * Convert a Blob to a base64 string. Reads the Blob into an ArrayBuffer,
   * manually constructs a binary string in chunks (to avoid call stack limits),
   * and base64-encodes it with window.btoa().
   */
  async function blobToBase64(blob) {
    const buffer = await blob.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000; // Process in 32KB chunks for performance/safety.

    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }

    return window.btoa(binary);
  }
})();