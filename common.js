"use strict";

(function () {
  const CHECK_ITEMS = [
    { key: "frame_model", label: "フレーム品番" },
    { key: "frame_color", label: "フレームカラー" },
    { key: "lens_color", label: "レンズカラー" },
    { key: "lens_curve", label: "レンズカーブ" },
    { key: "lens_shape", label: "レンズ形状" },
  ];

  const SCAN_COOLDOWN_MS = 1000;

  function parseQrText(text) {
    try {
      const payload = JSON.parse(text);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return { ok: false, message: "QRコードの形式が正しくありません。JSONオブジェクトを読み込んでください。" };
      }
      if (!payload.qr_type) {
        return { ok: false, payload, message: "QRコードの種類を判定できません。qr_type がありません。" };
      }
      return { ok: true, payload };
    } catch {
      return { ok: false, message: "QRコードの形式が正しくありません。JSON形式のQRコードを読み込んでください。" };
    }
  }

  function bindQrInput({ input, focusState, processButton, clearButton, onText, shouldFocus }) {
    const state = { inputTimer: null };

    function focusInput() {
      if (shouldFocus && !shouldFocus()) return;
      input.focus({ preventScroll: true });
      if (focusState) {
        focusState.textContent = document.activeElement === input ? "フォーカス中" : "入力待ち";
      }
    }

    function processInputField() {
      const text = input.value.trim();
      if (!text) {
        focusInput();
        return;
      }
      onText(text);
      input.value = "";
      focusInput();
    }

    processButton.addEventListener("click", processInputField);
    clearButton.addEventListener("click", () => {
      input.value = "";
      focusInput();
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        processInputField();
      }
    });

    input.addEventListener("input", () => {
      window.clearTimeout(state.inputTimer);
      state.inputTimer = window.setTimeout(() => {
        if (canParseJson(input.value)) processInputField();
      }, 250);
    });

    input.addEventListener("focus", () => {
      if (focusState) focusState.textContent = "フォーカス中";
    });
    input.addEventListener("blur", () => {
      if (focusState) focusState.textContent = "再フォーカス中";
      window.setTimeout(focusInput, 80);
    });

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) focusInput();
    });

    return { focusInput, processInputField };
  }

  function createCameraScanner({ video, canvas, overlay, cameraState, startButton, stopButton, onText, onError, shouldRefocus }) {
    const state = {
      stream: null,
      timer: null,
      barcodeDetector: null,
      lastText: "",
      lastAt: 0,
    };

    if ("BarcodeDetector" in window) {
      state.barcodeDetector = new window.BarcodeDetector({ formats: ["qr_code"] });
    }

    function init() {
      if (!state.barcodeDetector && typeof window.jsQR !== "function") {
        setCameraMessage("このブラウザはカメラQR読取に未対応です。Bluetoothリーダー入力を利用してください。");
      }
      startButton.addEventListener("click", startCamera);
      stopButton.addEventListener("click", () => stopCamera(true));
    }

    async function startCamera() {
      if (!navigator.mediaDevices?.getUserMedia) {
        const message = "カメラを起動できませんでした。HTTPSの公開URLで開いてください。";
        setCameraMessage(message);
        onError(message);
        refocus();
        return;
      }

      if (!state.barcodeDetector && typeof window.jsQR !== "function") {
        const message = "このブラウザではカメラQR読取を開始できません。";
        setCameraMessage(message);
        onError(message);
        refocus();
        return;
      }

      try {
        stopCamera(false);
        state.stream = await openCameraStream();
        video.srcObject = state.stream;
        video.setAttribute("playsinline", "true");
        video.setAttribute("muted", "true");
        video.muted = true;
        await video.play();
        cameraState.textContent = state.barcodeDetector ? "読取中" : "読取中 iPhone対応";
        overlay.hidden = true;
        state.timer = window.setInterval(scanCameraFrame, 180);
      } catch (error) {
        const message = `カメラを起動できませんでした。${error.message || ""}`;
        setCameraMessage(message);
        onError("カメラを起動できませんでした。Safari/Chromeのカメラ権限とHTTPSで開いていることを確認してください。");
      }
    }

    async function openCameraStream() {
      const preferred = {
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      };

      try {
        return await navigator.mediaDevices.getUserMedia(preferred);
      } catch {
        return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
    }

    function stopCamera(refocusInput = true) {
      if (state.timer) {
        window.clearInterval(state.timer);
        state.timer = null;
      }
      if (state.stream) {
        state.stream.getTracks().forEach((track) => track.stop());
        state.stream = null;
      }
      video.srcObject = null;
      cameraState.textContent = "停止中";
      setCameraMessage("カメラ未起動");
      if (refocusInput) refocus();
    }

    async function scanCameraFrame() {
      if (!state.stream || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

      try {
        const text = await readQrFromCamera();
        if (text) processCameraText(text);
      } catch {
        const text = readQrFromCanvas();
        if (text) processCameraText(text);
      }
    }

    async function readQrFromCamera() {
      if (state.barcodeDetector) {
        try {
          const results = await state.barcodeDetector.detect(video);
          if (results.length) return results[0].rawValue.trim();
        } catch {
          state.barcodeDetector = null;
          cameraState.textContent = "読取中 iPhone対応";
        }
      }
      return readQrFromCanvas();
    }

    function readQrFromCanvas() {
      if (typeof window.jsQR !== "function") return "";

      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!width || !height) return "";

      const context = canvas.getContext("2d", { willReadFrequently: true });
      canvas.width = width;
      canvas.height = height;
      context.drawImage(video, 0, 0, width, height);

      const imageData = context.getImageData(0, 0, width, height);
      const result = window.jsQR(imageData.data, width, height, {
        inversionAttempts: "dontInvert",
      });
      return result?.data?.trim() || "";
    }

    function processCameraText(text) {
      const now = Date.now();
      if (text === state.lastText && now - state.lastAt < SCAN_COOLDOWN_MS) return;
      state.lastText = text;
      state.lastAt = now;
      onText(text);
    }

    function setCameraMessage(message) {
      overlay.hidden = false;
      overlay.textContent = message;
    }

    function refocus() {
      if (shouldRefocus) shouldRefocus();
    }

    return {
      init,
      isActive: () => Boolean(state.stream),
      stop: stopCamera,
    };
  }

  function showResult(els, kind, mark, message) {
    els.resultPanel.className = `result-panel ${kind}`;
    els.resultMark.textContent = mark;
    const [title, ...rest] = String(message).split("\n");
    els.resultTitle.textContent = title || mark;
    els.resultDetail.textContent = rest.join(" / ") || "";
  }

  function notify(type) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;

    const audio = new AudioContextClass();
    const now = audio.currentTime;

    if (type === "ok" || type === "info") {
      playTone(audio, 880, now, 0.08, "sine");
      playTone(audio, 1175, now + 0.1, 0.12, "sine");
    } else if (type === "warn") {
      playTone(audio, 520, now, 0.14, "triangle");
    } else {
      playTone(audio, 180, now, 0.18, "sawtooth");
      playTone(audio, 150, now + 0.2, 0.18, "sawtooth");
    }

    window.setTimeout(() => audio.close(), 600);
  }

  function playTone(audio, frequency, start, duration, type) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = frequency;
    osc.type = type;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.16, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain);
    gain.connect(audio.destination);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  function hasValue(value) {
    return value !== undefined && value !== null && String(value) !== "";
  }

  function canParseJson(value) {
    try {
      JSON.parse(value);
      return true;
    } catch {
      return false;
    }
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    }[char]));
  }

  function itemLabel(key) {
    return CHECK_ITEMS.find((item) => item.key === key)?.label || key || "-";
  }

  window.QRCommon = {
    CHECK_ITEMS,
    bindQrInput,
    canParseJson,
    createCameraScanner,
    escapeHtml,
    hasValue,
    itemLabel,
    notify,
    parseQrText,
    showResult,
  };
}());
