"use strict";

const {
  CHECK_ITEMS,
  bindQrInput,
  createCameraScanner,
  escapeHtml,
  hasValue,
  itemLabel,
  notify,
  parseQrText,
  showResult: showCommonResult,
} = window.QRCommon;

const STORAGE_KEY = "tlxQrSingleCheckState.v1";

const state = {
  order: null,
  latestResult: null,
  history: [],
  qrInput: null,
  camera: null,
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
  singleResultDetails: document.querySelector("#singleResultDetails"),
  historyBody: document.querySelector("#historyBody"),
  resetButton: document.querySelector("#resetButton"),
  clearHistoryButton: document.querySelector("#clearHistoryButton"),
  cameraVideo: document.querySelector("#cameraVideo"),
  cameraCanvas: document.querySelector("#cameraCanvas"),
  cameraOverlay: document.querySelector("#cameraOverlay"),
  cameraState: document.querySelector("#cameraState"),
  startCameraButton: document.querySelector("#startCameraButton"),
  stopCameraButton: document.querySelector("#stopCameraButton"),
};

init();

function init() {
  restoreState();
  renderAll();
  bindEvents();

  state.qrInput = bindQrInput({
    input: els.qrInput,
    focusState: els.focusState,
    processButton: els.processInputButton,
    clearButton: els.clearInputButton,
    onText: processQrText,
    shouldFocus: () => !state.camera?.isActive(),
  });

  state.camera = createCameraScanner({
    video: els.cameraVideo,
    canvas: els.cameraCanvas,
    overlay: els.cameraOverlay,
    cameraState: els.cameraState,
    startButton: els.startCameraButton,
    stopButton: els.stopCameraButton,
    onText: processQrText,
    onError: (message) => showResult("error", "カメラエラー", message),
    shouldRefocus: ensureInputFocus,
  });
  state.camera.init();
  ensureInputFocus();
}

function bindEvents() {
  els.resetButton.addEventListener("click", resetCurrentOrder);
  els.clearHistoryButton.addEventListener("click", () => {
    state.history = [];
    saveState();
    renderHistory();
    ensureInputFocus();
  });
}

function processQrText(text) {
  const parsed = parseQrText(text);
  if (!parsed.ok) {
    handleError(parsed.payload, parsed.message);
    return;
  }

  const payload = parsed.payload;
  if (payload.qr_type === "order") {
    handleOrderQr(payload);
    return;
  }
  if (payload.qr_type === "shelf") {
    handleShelfQr(payload);
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

  state.order = normalizeOrder(payload);
  state.latestResult = null;
  recordHistory({
    orderId: state.order.order_id,
    qrType: "order",
    result: "OK",
    detail: "伝票QR読取",
  });
  notify("info");
  showResult("info", "伝票QR読取", `注文番号：${state.order.order_id}`);
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

  const expected = String(state.order[payload.check_item]);
  const actual = String(payload.value);
  const ok = expected === actual;
  const label = payload.label || "-";
  const result = ok ? "OK" : "NG";
  const title = ok ? `${itemLabel(payload.check_item)} 一致` : `${itemLabel(payload.check_item)}が違います`;
  const detail = `伝票指定：${expected} / 読取値：${actual} / 棚：${label}`;

  state.latestResult = {
    checkItem: payload.check_item,
    result,
    expected,
    actual,
    label,
    time: new Date().toLocaleTimeString("ja-JP", { hour12: false }),
  };

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

  notify(ok ? "ok" : "error");
  showResult(ok ? "ok" : "ng", result, `${title}\n${detail}`);
  saveState();
  renderAll();
}

function handleError(payload, message) {
  state.latestResult = {
    checkItem: payload?.check_item || "-",
    result: "エラー",
    expected: "-",
    actual: payload?.value || "-",
    label: payload?.label || "-",
    time: new Date().toLocaleTimeString("ja-JP", { hour12: false }),
  };
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
  renderAll();
}

function resetCurrentOrder() {
  state.order = null;
  state.latestResult = null;
  saveState();
  renderAll();
  showResult("neutral", "待機", "伝票QRを読み込んでください。");
  ensureInputFocus();
}

function renderAll() {
  renderBadge();
  renderOrder();
  renderLatestResult();
  renderHistory();
}

function renderBadge() {
  if (!state.order) {
    els.completionBadge.textContent = "注文未読込";
    els.completionBadge.className = "completion-badge idle";
    return;
  }
  els.completionBadge.textContent = `単項目チェック中 ${state.order.order_id}`;
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

function renderLatestResult() {
  const latest = state.latestResult;
  const values = [
    ["照合項目", latest ? itemLabel(latest.checkItem) : "-"],
    ["判定", latest?.result || "-"],
    ["伝票指定", latest?.expected || "-"],
    ["読取値", latest?.actual || "-"],
    ["表示名", latest?.label || "-"],
    ["読取時刻", latest?.time || "-"],
  ];

  els.singleResultDetails.innerHTML = values.map(([label, value]) => `
    <div>
      <dt>${escapeHtml(label)}</dt>
      <dd>${escapeHtml(value)}</dd>
    </div>
  `).join("");
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
        <td>${escapeHtml(itemLabel(entry.checkItem))}</td>
        <td class="history-result ${resultClass}">${escapeHtml(entry.result || "-")}</td>
        <td>${escapeHtml(entry.detail || entry.actual || "-")}</td>
      </tr>
    `;
  }).join("");
}

function showResult(kind, mark, message) {
  showCommonResult(els, kind, mark, message);
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

function saveState() {
  const serializable = {
    order: state.order,
    latestResult: state.latestResult,
    history: state.history,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
}

function restoreState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    state.order = saved.order || null;
    state.latestResult = saved.latestResult || null;
    state.history = Array.isArray(saved.history) ? saved.history : [];
  } catch {
    state.order = null;
    state.latestResult = null;
    state.history = [];
  }
}

function normalizeOrder(order) {
  const normalized = { qr_type: "order", order_id: String(order.order_id) };
  CHECK_ITEMS.forEach((item) => {
    normalized[item.key] = String(order[item.key]);
  });
  return normalized;
}

function ensureInputFocus() {
  state.qrInput?.focusInput();
}
