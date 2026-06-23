"use strict";

const CHECK_ITEMS = [
  { key: "frame_model", label: "フレーム品番" },
  { key: "frame_color", label: "フレームカラー" },
  { key: "lens_color", label: "レンズカラー" },
  { key: "lens_curve", label: "レンズカーブ" },
  { key: "lens_shape", label: "レンズ形状" },
];

const STORAGE_KEY = "tlxQrCheckState.v1";
const SCAN_COOLDOWN_MS = 1000;

const state = {
  order: null,
  checks: createEmptyChecks(),
  history: [],
  pendingOrder: null,
  cameraStream: null,
  cameraTimer: null,
  barcodeDetector: null,
  lastCameraText: "",
  lastCameraAt: 0,
  inputTimer: null,
};

const els = {
  completionBadge: document.querySelector("#completionBadge"),
  resultPanel: document.querySelector("#resultPanel"),
  resultMark: document.querySelector("#resultMark"),
  resultTitle: document.querySelector("#resultTitle"),
  resultDetail: document.querySelector("#resultDetail"),
  qrInput: document.querySelector("#qrInput"),
  focusState: document.querySelector("#focusState"),
  processInputButton: document.querySelector("#processInputButton"),
  clearInputButton: document.querySelector("#clearInputButton"),
  orderDetails: document.querySelector("#orderDetails"),
  checkList: document.querySelector("#checkList"),
  historyBody: document.querySelector("#historyBody"),
  resetButton: document.querySelector("#resetButton"),
  switchOrderButton: document.querySelector("#switchOrderButton"),
  clearHistoryButton: document.querySelector("#clearHistoryButton"),
  cameraVideo: document.querySelector("#cameraVideo"),
  cameraCanvas: document.querySelector("#cameraCanvas"),
  cameraOverlay: document.querySelector("#cameraOverlay"),
  cameraState: document.querySelector("#cameraState"),
  startCameraButton: document.querySelector("#startCameraButton"),
  stopCameraButton: document.querySelector("#stopCameraButton"),
  confirmModal: document.querySelector("#confirmModal"),
  modalMessage: document.querySelector("#modalMessage"),
  cancelSwitchButton: document.querySelector("#cancelSwitchButton"),
  confirmSwitchButton: document.querySelector("#confirmSwitchButton"),
};

init();

function init() {
  restoreState();
  renderAll();
  bindEvents();
  ensureInputFocus();

  if ("BarcodeDetector" in window) {
    state.barcodeDetector = new window.BarcodeDetector({ formats: ["qr_code"] });
  }

  if (!state.barcodeDetector && typeof window.jsQR !== "function") {
    setCameraMessage("このブラウザはカメラQR読取に未対応です。Bluetoothリーダー入力を利用してください。");
  }
}

function bindEvents() {
  els.processInputButton.addEventListener("click", processInputField);
  els.clearInputButton.addEventListener("click", () => {
    els.qrInput.value = "";
    ensureInputFocus();
  });

  els.qrInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      processInputField();
    }
  });

  els.qrInput.addEventListener("input", () => {
    window.clearTimeout(state.inputTimer);
    state.inputTimer = window.setTimeout(() => {
      if (canParseJson(els.qrInput.value)) {
        processInputField();
      }
    }, 250);
  });

  els.qrInput.addEventListener("focus", () => {
    els.focusState.textContent = "フォーカス中";
  });
  els.qrInput.addEventListener("blur", () => {
    els.focusState.textContent = "再フォーカス中";
    window.setTimeout(ensureInputFocus, 80);
  });

  els.resetButton.addEventListener("click", resetCurrentOrder);
  els.switchOrderButton.addEventListener("click", requestManualSwitch);
  els.clearHistoryButton.addEventListener("click", () => {
    state.history = [];
    saveState();
    renderHistory();
    ensureInputFocus();
  });

  els.startCameraButton.addEventListener("click", startCamera);
  els.stopCameraButton.addEventListener("click", stopCamera);

  els.cancelSwitchButton.addEventListener("click", () => {
    state.pendingOrder = null;
    hideModal();
    showResult("warn", "キャンセル", "注文切替をキャンセルしました。");
    ensureInputFocus();
  });
  els.confirmSwitchButton.addEventListener("click", () => {
    const order = state.pendingOrder;
    state.pendingOrder = null;
    hideModal();
    if (order) {
      loadOrder(order, "新しい注文に切り替えました。");
    }
    ensureInputFocus();
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) ensureInputFocus();
  });
}

function processInputField() {
  const text = els.qrInput.value.trim();
  if (!text) {
    ensureInputFocus();
    return;
  }

  processQrText(text);
  els.qrInput.value = "";
  ensureInputFocus();
}

function processQrText(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    recordHistory({
      qrType: "-",
      result: "エラー",
      detail: "QRコードの形式が正しくありません。JSON形式のQRコードを読み込んでください。",
    });
    notify("error");
    showResult("error", "エラー", "QRコードの形式が正しくありません。JSON形式のQRコードを読み込んでください。");
    return;
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    handleError(payload, "QRコードの形式が正しくありません。JSONオブジェクトを読み込んでください。");
    return;
  }

  if (!payload.qr_type) {
    handleError(payload, "QRコードの種類を判定できません。qr_type がありません。");
    return;
  }

  if (payload.qr_type === "order") {
    handleOrderQr(payload);
    return;
  }

  if (payload.qr_type === "shelf") {
    handleShelfQr(payload);
    return;
  }

  if (payload.qr_type === "item") {
    handleError(payload, "現物QRは将来対応です。初期版では棚QRを読み込んでください。");
    return;
  }

  handleError(payload, "未対応のQRコードです。");
}

function handleOrderQr(payload) {
  const missing = ["order_id", ...CHECK_ITEMS.map((item) => item.key)].filter((key) => !hasValue(payload[key]));
  if (missing.length > 0) {
    handleError(payload, `伝票QRに必要な項目がありません。${missing.join(", ")}`);
    return;
  }

  if (state.order && !isComplete()) {
    state.pendingOrder = payload;
    showSwitchModal(payload);
    recordHistory({
      orderId: state.order.order_id,
      qrType: "order",
      result: "エラー",
      detail: `未完了注文中に別伝票QRを読取: ${payload.order_id}`,
    });
    saveState();
    renderHistory();
    notify("warn");
    return;
  }

  const message = state.order && isComplete()
    ? `前の注文は全項目OKです。新しい注文に切り替えました。注文番号：${payload.order_id}`
    : "伝票QRを読み込みました。";
  loadOrder(payload, message);
}

function loadOrder(order, message) {
  state.order = normalizeOrder(order);
  state.checks = createEmptyChecks();
  recordHistory({
    orderId: state.order.order_id,
    qrType: "order",
    result: "OK",
    detail: "伝票QR読取",
  });
  notify("info");
  showResult("info", "伝票QR読取", message);
  saveState();
  renderAll();
}

function handleShelfQr(payload) {
  if (!state.order) {
    handleError(payload, "先に伝票QRを読み込んでください。");
    return;
  }

  if (!payload.check_item) {
    handleError(payload, "棚QRの形式が正しくありません。check_item がありません。");
    return;
  }

  if (!CHECK_ITEMS.some((item) => item.key === payload.check_item)) {
    handleError(payload, "未対応の照合項目です。");
    return;
  }

  if (!hasValue(payload.value)) {
    handleError(payload, "棚QRの形式が正しくありません。value がありません。");
    return;
  }

  if (!hasValue(state.order[payload.check_item])) {
    handleError(payload, "伝票QRに該当項目がありません。");
    return;
  }

  const item = CHECK_ITEMS.find((entry) => entry.key === payload.check_item);
  const expected = String(state.order[payload.check_item]);
  const actual = String(payload.value);
  const ok = expected === actual;
  state.checks[payload.check_item] = ok ? "ok" : "ng";

  const label = payload.label || "-";
  const result = ok ? "OK" : "NG";
  const title = ok ? `${item.label} 一致` : `${item.label}が違います`;
  const detail = `伝票指定：${expected} / 読取値：${actual} / 棚：${label}`;

  recordHistory({
    orderId: state.order.order_id,
    qrType: "shelf",
    checkItem: payload.check_item,
    expected,
    actual,
    result,
    label,
    detail,
  });

  notify(ok ? "ok" : "ng");
  showResult(ok ? "ok" : "ng", result, `${title}\n${detail}`);
  saveState();
  renderAll();

  if (ok && isComplete()) {
    window.setTimeout(() => {
      showResult("ok", "全項目OK", "次工程へ進めます。");
      renderCompletion();
    }, 240);
  }
}

function handleError(payload, message) {
  recordHistory({
    orderId: state.order?.order_id || "-",
    qrType: payload?.qr_type || "-",
    checkItem: payload?.check_item || "-",
    actual: payload?.value || "-",
    result: "エラー",
    label: payload?.label || "-",
    detail: message,
  });
  notify("error");
  showResult("error", "エラー", message);
  saveState();
  renderHistory();
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setCameraMessage("このブラウザではカメラを起動できません。HTTPSの公開URLで開いてください。");
    showResult("error", "カメラエラー", "カメラを起動できませんでした。HTTPSの公開URLで開いてください。");
    ensureInputFocus();
    return;
  }

  if (!state.barcodeDetector && typeof window.jsQR !== "function") {
    setCameraMessage("このブラウザではカメラQR読取を開始できません。");
    ensureInputFocus();
    return;
  }

  try {
    stopCamera(false);
    state.cameraStream = await openCameraStream();
    els.cameraVideo.srcObject = state.cameraStream;
    els.cameraVideo.setAttribute("playsinline", "true");
    els.cameraVideo.setAttribute("muted", "true");
    els.cameraVideo.muted = true;
    await els.cameraVideo.play();
    els.cameraState.textContent = state.barcodeDetector ? "読取中" : "読取中 iPhone対応";
    els.cameraOverlay.hidden = true;
    state.cameraTimer = window.setInterval(scanCameraFrame, 180);
  } catch (error) {
    setCameraMessage(`カメラを起動できませんでした。${error.message || ""}`);
    showResult("error", "カメラエラー", "カメラを起動できませんでした。Safari/Chromeのカメラ権限とHTTPSで開いていることを確認してください。");
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
  } catch (error) {
    return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  }
}

function stopCamera(refocus = true) {
  if (state.cameraTimer) {
    window.clearInterval(state.cameraTimer);
    state.cameraTimer = null;
  }
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach((track) => track.stop());
    state.cameraStream = null;
  }
  els.cameraVideo.srcObject = null;
  els.cameraState.textContent = "停止中";
  setCameraMessage("カメラ未起動");
  if (refocus) ensureInputFocus();
}

async function scanCameraFrame() {
  if (!state.cameraStream || els.cameraVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

  try {
    const text = await readQrFromCamera();
    if (!text) return;
    processCameraText(text);
  } catch {
    const text = readQrFromCanvas();
    if (text) {
      processCameraText(text);
    }
  }
}

async function readQrFromCamera() {
  if (state.barcodeDetector) {
    try {
      const results = await state.barcodeDetector.detect(els.cameraVideo);
      if (results.length) return results[0].rawValue.trim();
    } catch {
      state.barcodeDetector = null;
      els.cameraState.textContent = "読取中 iPhone対応";
    }
  }

  return readQrFromCanvas();
}

function readQrFromCanvas() {
  if (typeof window.jsQR !== "function") return "";

  const width = els.cameraVideo.videoWidth;
  const height = els.cameraVideo.videoHeight;
  if (!width || !height) return "";

  const canvas = els.cameraCanvas;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  canvas.width = width;
  canvas.height = height;
  context.drawImage(els.cameraVideo, 0, 0, width, height);

  const imageData = context.getImageData(0, 0, width, height);
  const result = window.jsQR(imageData.data, width, height, {
    inversionAttempts: "dontInvert",
  });

  return result?.data?.trim() || "";
}

function processCameraText(text) {
  const now = Date.now();
  if (text === state.lastCameraText && now - state.lastCameraAt < SCAN_COOLDOWN_MS) return;

  state.lastCameraText = text;
  state.lastCameraAt = now;
  processQrText(text);
}

function setCameraMessage(message) {
  els.cameraOverlay.hidden = false;
  els.cameraOverlay.textContent = message;
}

function requestManualSwitch() {
  if (!state.order) {
    showResult("warn", "注文未読込", "現在の注文はありません。");
    ensureInputFocus();
    return;
  }

  if (!isComplete()) {
    showResult("warn", "未完了", `現在の注文 ${state.order.order_id} はまだ全項目OKになっていません。新しい伝票QRを読み込むと切替確認が表示されます。`);
    ensureInputFocus();
    return;
  }

  resetCurrentOrder();
  showResult("info", "新しい注文待ち", "次の伝票QRを読み込んでください。");
}

function resetCurrentOrder() {
  state.order = null;
  state.checks = createEmptyChecks();
  state.pendingOrder = null;
  saveState();
  renderAll();
  showResult("neutral", "待機", "伝票QRを読み込んでください。");
  ensureInputFocus();
}

function showSwitchModal(newOrder) {
  els.modalMessage.textContent = [
    "現在の注文はまだ全項目OKになっていません。",
    `現在の注文：${state.order.order_id}`,
    `新しく読み込んだ注文：${newOrder.order_id}`,
    "現在の注文を中断して、新しい注文に切り替えますか？",
  ].join("\n");
  els.confirmModal.hidden = false;
  els.cancelSwitchButton.focus();
}

function hideModal() {
  els.confirmModal.hidden = true;
}

function renderAll() {
  renderCompletion();
  renderOrder();
  renderChecks();
  renderHistory();
}

function renderCompletion() {
  if (!state.order) {
    els.completionBadge.textContent = "注文未読込";
    els.completionBadge.className = "completion-badge idle";
    return;
  }

  if (isComplete()) {
    els.completionBadge.textContent = "全項目OK 次工程へ進めます";
    els.completionBadge.className = "completion-badge complete";
    return;
  }

  els.completionBadge.textContent = `照合中 ${countOk()} / ${CHECK_ITEMS.length}`;
  els.completionBadge.className = "completion-badge pending";
}

function renderOrder() {
  const values = [
    ["注文番号", state.order?.order_id],
    ...CHECK_ITEMS.map((item) => [item.label, state.order?.[item.key]]),
  ];

  els.orderDetails.innerHTML = values.map(([label, value]) => `
    <div>
      <dt>${escapeHtml(label)}</dt>
      <dd>${escapeHtml(hasValue(value) ? String(value) : "-")}</dd>
    </div>
  `).join("");
}

function renderChecks() {
  els.checkList.innerHTML = CHECK_ITEMS.map((item) => {
    const status = state.checks[item.key] || "unchecked";
    const label = status === "ok" ? "OK" : status === "ng" ? "NG" : "未";
    return `
      <li class="check-item ${status}">
        <strong>${escapeHtml(item.label)}</strong>
        <span>${label}</span>
      </li>
    `;
  }).join("");
}

function renderHistory() {
  if (!state.history.length) {
    els.historyBody.innerHTML = '<tr><td colspan="6" class="empty">履歴はまだありません。</td></tr>';
    return;
  }

  els.historyBody.innerHTML = state.history.slice(0, 80).map((entry) => {
    const resultClass = entry.result === "OK" ? "ok" : entry.result === "NG" ? "ng" : "error";
    return `
      <tr>
        <td>${escapeHtml(entry.time)}</td>
        <td>${escapeHtml(entry.orderId || "-")}</td>
        <td>${escapeHtml(entry.qrType || "-")}</td>
        <td>${escapeHtml(getItemLabel(entry.checkItem))}</td>
        <td class="history-result ${resultClass}">${escapeHtml(entry.result || "-")}</td>
        <td>${escapeHtml(entry.detail || entry.actual || "-")}</td>
      </tr>
    `;
  }).join("");
}

function showResult(kind, mark, message) {
  els.resultPanel.className = `result-panel ${kind}`;
  els.resultMark.textContent = mark;
  const [title, ...rest] = String(message).split("\n");
  els.resultTitle.textContent = title || mark;
  els.resultDetail.textContent = rest.join(" / ") || "";
}

function recordHistory(entry) {
  const saved = {
    time: new Date().toLocaleTimeString("ja-JP", { hour12: false }),
    orderId: entry.orderId || state.order?.order_id || "-",
    qrType: entry.qrType || "-",
    checkItem: entry.checkItem || "-",
    expected: entry.expected || "-",
    actual: entry.actual || "-",
    result: entry.result || "-",
    label: entry.label || "-",
    detail: entry.detail || "-",
  };
  state.history.unshift(saved);
  state.history = state.history.slice(0, 200);
}

function notify(type) {
  const audio = new (window.AudioContext || window.webkitAudioContext)();
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

function saveState() {
  const serializable = {
    order: state.order,
    checks: state.checks,
    history: state.history,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
}

function restoreState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    state.order = saved.order || null;
    state.checks = { ...createEmptyChecks(), ...(saved.checks || {}) };
    state.history = Array.isArray(saved.history) ? saved.history : [];
  } catch {
    state.order = null;
    state.checks = createEmptyChecks();
    state.history = [];
  }
}

function createEmptyChecks() {
  return Object.fromEntries(CHECK_ITEMS.map((item) => [item.key, "unchecked"]));
}

function isComplete() {
  return CHECK_ITEMS.every((item) => state.checks[item.key] === "ok");
}

function countOk() {
  return CHECK_ITEMS.filter((item) => state.checks[item.key] === "ok").length;
}

function normalizeOrder(order) {
  const normalized = { qr_type: "order", order_id: String(order.order_id) };
  CHECK_ITEMS.forEach((item) => {
    normalized[item.key] = String(order[item.key]);
  });
  return normalized;
}

function getItemLabel(key) {
  return CHECK_ITEMS.find((item) => item.key === key)?.label || key || "-";
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

function ensureInputFocus() {
  if (state.cameraStream) return;
  if (!els.confirmModal.hidden) return;
  els.qrInput.focus({ preventScroll: true });
  els.focusState.textContent = document.activeElement === els.qrInput ? "フォーカス中" : "入力待ち";
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
