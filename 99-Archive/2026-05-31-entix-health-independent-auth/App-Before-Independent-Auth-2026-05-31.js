const loginPanel = document.querySelector("#loginPanel");
const appPanel = document.querySelector("#appPanel");
const statusText = document.querySelector("#statusText");
const statusPill = document.querySelector("#statusPill");
const loginForm = document.querySelector("#loginForm");
const loginMessage = document.querySelector("#loginMessage");
const googleLogin = document.querySelector("#googleLogin");
const oauthNote = document.querySelector("#oauthNote");
const chatForm = document.querySelector("#chatForm");
const questionInput = document.querySelector("#question");
const messages = document.querySelector("#messages");
const chatView = document.querySelector("#chatView");
const chatDropOverlay = document.querySelector("#chatDropOverlay");
const uploadForm = document.querySelector("#uploadForm");
const fileInput = document.querySelector("#fileInput");
const filePickerButton = document.querySelector("#filePickerButton");
const filePickerSummary = document.querySelector("#filePickerSummary");
const selectedFilesList = document.querySelector("#selectedFilesList");
const clearSelectedFiles = document.querySelector("#clearSelectedFiles");
const uploadMessage = document.querySelector("#uploadMessage");
const documentsEl = document.querySelector("#documents");
const settingsDocumentsEl = document.querySelector("#settingsDocuments");
const reportList = document.querySelector("#reportList");
const adminPanel = document.querySelector("#adminPanel");
const addUserForm = document.querySelector("#addUserForm");
const usersList = document.querySelector("#usersList");
const debugPanel = document.querySelector("#debugPanel");
const debugBox = document.querySelector("#debugBox");
const uploadReportsButton = document.querySelector("#uploadReportsButton");
const profileName = document.querySelector("#profileName");
const profileSub = document.querySelector("#profileSub");
const projectCode = document.querySelector("#projectCode");
const pinnedConversations = document.querySelector("#pinnedConversations");
const conversationList = document.querySelector("#conversationList");
const conversationSearch = document.querySelector("#conversationSearch");
const pinCurrentButton = document.querySelector("#pinCurrentButton");
const viewTitle = document.querySelector("#viewTitle");
const reportsCount = document.querySelector("#reportsCount");
const documentsCount = document.querySelector("#documentsCount");
const memoryCount = document.querySelector("#memoryCount");
const healthSignalGrid = document.querySelector("#healthSignalGrid");
const riskAlertsList = document.querySelector("#riskAlertsList");
const nextActionsList = document.querySelector("#nextActionsList");
const labTrendList = document.querySelector("#labTrendList");
const medicationList = document.querySelector("#medicationList");
const profileSummary = document.querySelector("#profileSummary");
const protocolMini = document.querySelector("#protocolMini");
const protocolSections = document.querySelector("#protocolSections");
const printProtocolButton = document.querySelector("#printProtocolButton");
const documentPreviewModal = document.querySelector("#documentPreviewModal");
const previewBackdrop = document.querySelector("#previewBackdrop");
const previewClose = document.querySelector("#previewClose");
const previewTitle = document.querySelector("#previewTitle");
const previewSubtitle = document.querySelector("#previewSubtitle");
const previewBody = document.querySelector("#previewBody");

let bootstrap = null;
let conversations = [];
let currentConversationId = null;
let debugEnabled = false;
let currentView = "chat";
let chatSubmitting = false;
let dashboardRefreshInFlight = false;
let latestDashboardData = null;
let selectedFiles = [];
let selectedFileStatuses = new Map();
let dragDepth = 0;

const VALID_VIEWS = new Set(["chat", "dashboard", "protocol", "settings", "admin"]);
const VIEW_STATE_KEY = "tper-health-current-view";

function safeSessionGet(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSessionSet(key, value) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Session storage can be unavailable in locked-down browser contexts.
  }
}

function requestedView() {
  const hashView = location.hash.replace(/^#/, "");
  const storedView = safeSessionGet(VIEW_STATE_KEY);
  const view = VALID_VIEWS.has(hashView) ? hashView : VALID_VIEWS.has(storedView || "") ? storedView : "chat";
  if (view === "admin" && !bootstrap?.auth?.is_admin) return "chat";
  return view;
}

function browserNavigationType() {
  const nav = performance.getEntriesByType?.("navigation")?.[0];
  return nav?.type || (performance.navigation?.type === 1 ? "reload" : "navigate");
}

async function enforceReloadLock() {
  if (browserNavigationType() !== "reload") return false;
  await api("/api/logout", { method: "POST" }).catch(() => {});
  showLogin("Session locked after refresh. Sign in again to protect the health file.");
  return true;
}

function setStatus(kind, text) {
  statusText.textContent = text;
  statusPill.textContent = kind === "ok" ? "online" : kind === "bad" ? "blocked" : "partial";
  statusPill.dataset.kind = kind;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: options.body instanceof FormData ? undefined : { "content-type": "application/json" },
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed: ${response.status}`);
  return payload;
}

function timeLabel(value) {
  if (!value) return "";
  const date = new Date(value);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatBytes(bytes = 0) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, index);
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function fileKey(file) {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

function fileKindLabel(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf")) return "PDF";
  if (/\.(png|jpg|jpeg|heic|webp)$/i.test(name)) return "Image";
  if (/\.(md|txt)$/i.test(name)) return "Text";
  if (name.endsWith(".csv")) return "CSV";
  return file.type || "File";
}

function documentKindLabel(document = {}) {
  if (document.document_type === "lab_pdf" || (document.title || "").toLowerCase().endsWith(".pdf")) return "PDF";
  if (document.document_type === "image_report") return "Image";
  if (document.document_type === "text_report") return "Text";
  return "File";
}

function documentPreviewUrl(document = {}) {
  return document.id ? `/api/documents/${document.id}/file` : "";
}

function resultDocument(result) {
  return result?.document || null;
}

function resultForFile(file, results = [], index = 0) {
  return results.find((item) => [item.file_name, item.filename, item.original_name, item.title, item.name, item.document?.title].includes(file.name)) || results[index] || null;
}

function uploadVisualStatus(result, state = "ready") {
  if (state === "uploading") return "Saving";
  if (!result) return "Ready";
  if (result.status === "failed") return "Failed";
  if (result.duplicate) return "Already saved";
  if (result.ocr_status === "queued") return "Saved · OCR queued";
  if (result.ocr_status === "processing") return "Saved · OCR reading";
  if (result.ocr_status === "completed") return "Saved · OCR complete";
  return "Saved";
}

function documentOcrLabel(doc) {
  const ocr = doc.metadata?.ocr?.status;
  if (ocr === "completed") return "OCR complete";
  if (ocr === "processing") return "OCR reading";
  if (ocr === "queued") return "OCR queued";
  if (ocr === "failed") return "OCR failed";
  return "Saved";
}

function markerValue(value, unit) {
  if (value === null || value === undefined || value === "") return "Not available";
  return `${value}${unit ? ` ${unit}` : ""}`;
}

function trendLabel(trend) {
  if (trend.delta === null || trend.delta === undefined) return "Single reading";
  if (trend.delta > 0) return `Up ${trend.delta}${trend.unit ? ` ${trend.unit}` : ""}`;
  if (trend.delta < 0) return `Down ${Math.abs(trend.delta)}${trend.unit ? ` ${trend.unit}` : ""}`;
  return "Stable";
}

function trendTone(trend) {
  if (trend.flag === "high" || trend.flag === "critical" || trend.flag === "out_of_range") return "warn";
  if (trend.flag === "low") return "low";
  if (trend.direction === "up") return "up";
  if (trend.direction === "down") return "down";
  return "flat";
}

function signalTone(signal = {}) {
  if (signal.status === "alert") return "alert";
  if (signal.status === "watch" || signal.status === "needs_review") return "watch";
  if (signal.status === "good") return "good";
  return "pending";
}

function deltaLabel(item = {}) {
  if (item.delta === null || item.delta === undefined) return "Single reading";
  const value = `${item.delta > 0 ? "+" : ""}${item.delta}${item.unit ? ` ${item.unit}` : ""}`;
  return `${item.direction === "up" ? "Up" : item.direction === "down" ? "Down" : "Stable"} · ${value}`;
}

function renderSparkline(points = []) {
  const values = points.map((point) => Number(point.value)).filter((value) => Number.isFinite(value));
  if (values.length < 2) return `<div class="sparkline empty"></div>`;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const polyline = points
    .map((point, index) => {
      const value = Number(point.value);
      const x = points.length === 1 ? 50 : (index / (points.length - 1)) * 100;
      const y = Number.isFinite(value) ? 84 - ((value - min) / span) * 68 : 84;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return `<svg class="sparkline" viewBox="0 0 100 90" preserveAspectRatio="none" aria-hidden="true"><polyline points="${polyline}"></polyline></svg>`;
}

function renderHealthSignals(signals = []) {
  if (!healthSignalGrid) return;
  healthSignalGrid.innerHTML = "";
  if (!signals.length) {
    healthSignalGrid.innerHTML = `<div class="empty-row">Upload lab reports to start building monthly health signals.</div>`;
    return;
  }
  for (const signal of signals) {
    const card = document.createElement("article");
    card.className = `signal-card ${signalTone(signal)}`;
    card.innerHTML = `
      <div class="signal-head">
        <div>
          <div class="signal-domain"></div>
          <div class="signal-title"></div>
        </div>
        <div class="signal-status"></div>
      </div>
      <div class="signal-value"></div>
      <div class="signal-delta"></div>
      <div class="signal-chart"></div>
      <div class="signal-summary"></div>
    `;
    card.querySelector(".signal-domain").textContent = signal.domain || "Health";
    card.querySelector(".signal-title").textContent = signal.label || "Signal";
    card.querySelector(".signal-status").textContent = signal.status_label || "Pending";
    card.querySelector(".signal-value").textContent = markerValue(signal.latest_value, signal.unit);
    card.querySelector(".signal-delta").textContent = `${deltaLabel(signal)}${signal.latest_date ? ` · ${timeLabel(signal.latest_date)}` : ""}`;
    card.querySelector(".signal-chart").innerHTML = renderSparkline(signal.sparkline || []);
    card.querySelector(".signal-summary").textContent = signal.summary || "No summary yet.";
    healthSignalGrid.append(card);
  }
}

function renderRiskAlerts(alerts = []) {
  if (!riskAlertsList) return;
  riskAlertsList.innerHTML = "";
  if (!alerts.length) {
    riskAlertsList.innerHTML = `<div class="empty-row">No active safety alerts.</div>`;
    return;
  }
  for (const alert of alerts.slice(0, 6)) {
    const row = document.createElement("article");
    row.className = `risk-row ${alert.severity || "info"}`;
    row.innerHTML = `
      <div class="risk-code"></div>
      <div class="risk-copy">
        <div class="risk-title"></div>
        <div class="risk-detail"></div>
      </div>
    `;
    row.querySelector(".risk-code").textContent = alert.code || "Alert";
    row.querySelector(".risk-title").textContent = alert.title || "Alert";
    row.querySelector(".risk-detail").textContent = alert.detail || "";
    riskAlertsList.append(row);
  }
}

function renderNextActions(actions = []) {
  if (!nextActionsList) return;
  nextActionsList.innerHTML = "";
  if (!actions.length) {
    nextActionsList.innerHTML = `<div class="empty-row">Upload a newer report to show meaningful changes.</div>`;
    return;
  }
  for (const action of actions.slice(0, 5)) {
    const row = document.createElement("article");
    row.className = `action-row ${action.priority || "low"}`;
    row.innerHTML = `
      <div class="action-priority"></div>
      <div>
        <div class="action-title"></div>
        <div class="action-detail"></div>
      </div>
    `;
    row.querySelector(".action-priority").textContent = action.priority === "high" ? "High" : action.priority === "medium" ? "Watch" : "Low";
    row.querySelector(".action-title").textContent = action.title || "Action";
    row.querySelector(".action-detail").textContent = action.detail || "";
    nextActionsList.append(row);
  }
}

function renderProtocolMini(protocol = {}) {
  if (!protocolMini) return;
  protocolMini.innerHTML = "";
  const schedule = protocol.schedule || [];
  if (!schedule.length) {
    protocolMini.innerHTML = `<div class="empty-row">No structured protocol saved yet.</div>`;
    return;
  }
  for (const slot of schedule) {
    const row = document.createElement("article");
    row.className = "protocol-slot compact";
    row.innerHTML = `
      <div class="slot-label"></div>
      <div class="slot-items"></div>
      <div class="slot-notes"></div>
    `;
    row.querySelector(".slot-label").textContent = slot.label || slot.slot;
    row.querySelector(".slot-items").textContent = slot.items?.length ? slot.items.join(" · ") : "No saved items for this slot";
    row.querySelector(".slot-notes").textContent = slot.notes || "";
    protocolMini.append(row);
  }
}

function renderProtocolSections(protocol = {}) {
  if (!protocolSections) return;
  protocolSections.innerHTML = "";
  const schedule = protocol.schedule || [];
  const sections = protocol.print_sections || [];
  const scheduleSection = document.createElement("section");
  scheduleSection.className = "protocol-section";
  scheduleSection.innerHTML = `<h3>Daily administration schedule</h3><div class="protocol-schedule"></div>`;
  const scheduleList = scheduleSection.querySelector(".protocol-schedule");
  for (const slot of schedule) {
    const row = document.createElement("article");
    row.className = "protocol-slot";
    row.innerHTML = `
      <div class="slot-label"></div>
      <ul class="slot-items-list"></ul>
      <div class="slot-notes"></div>
    `;
    row.querySelector(".slot-label").textContent = slot.label || slot.slot;
    const list = row.querySelector(".slot-items-list");
    const items = slot.items?.length ? slot.items : ["No saved items for this slot"];
    for (const item of items) {
      const li = document.createElement("li");
      li.textContent = item;
      list.append(li);
    }
    row.querySelector(".slot-notes").textContent = slot.notes || "";
    scheduleList.append(row);
  }
  protocolSections.append(scheduleSection);

  for (const section of sections) {
    const block = document.createElement("section");
    block.className = "protocol-section";
    block.innerHTML = `<h3></h3><ul></ul>`;
    block.querySelector("h3").textContent = section.title;
    const list = block.querySelector("ul");
    const body = section.body?.length ? section.body : ["No saved data."];
    for (const item of body) {
      const li = document.createElement("li");
      li.textContent = item;
      list.append(li);
    }
    protocolSections.append(block);
  }
}

function renderLabTrends(trends = []) {
  if (!labTrendList) return;
  labTrendList.innerHTML = "";
  if (!trends.length) {
    labTrendList.innerHTML = `<div class="empty-row">Files are saved, but no structured numeric markers are available yet. OCR or extraction is still pending.</div>`;
    return;
  }
  for (const trend of trends.slice(0, 12)) {
    const row = document.createElement("article");
    row.className = `trend-row ${trendTone(trend)}`;
    row.innerHTML = `
      <div class="trend-head">
        <div class="trend-name"></div>
        <div class="trend-value"></div>
      </div>
      <div class="trend-meta"></div>
      <div class="trend-bar"><span></span></div>
    `;
    row.querySelector(".trend-name").textContent = trend.marker_name;
    row.querySelector(".trend-value").textContent = markerValue(trend.latest_value, trend.unit);
    row.querySelector(".trend-meta").textContent = `${trendLabel(trend)} · ${trend.samples || 1} reading${trend.samples === 1 ? "" : "s"}${trend.previous_value ? ` · Previous ${markerValue(trend.previous_value, trend.unit)}` : ""}`;
    const width = Math.min(100, Math.max(18, Math.abs(Number(trend.delta || trend.latest_numeric || 25)) * 7));
    row.querySelector(".trend-bar span").style.width = `${width}%`;
    labTrendList.append(row);
  }
}

function renderMedicationList(medications = [], supplements = [], conditions = []) {
  if (!medicationList) return;
  medicationList.innerHTML = "";
  const rows = [
    ...medications.map((item) => ({ ...item, group: "Medication" })),
    ...supplements.map((item) => ({ ...item, group: "Supplement" })),
    ...conditions.map((item) => ({ ...item, group: "Condition" }))
  ];
  if (!rows.length) {
    medicationList.innerHTML = `<div class="empty-row">No saved medication schedule yet. Add it in chat with a clear sentence such as: "Record Levothyroxine 50mcg in the morning."</div>`;
    return;
  }
  for (const item of rows.slice(0, 14)) {
    const row = document.createElement("article");
    row.className = "med-row";
    row.innerHTML = `
      <div class="med-kind"></div>
      <div class="med-main">
        <div class="med-title"></div>
        <div class="med-meta"></div>
      </div>
    `;
    row.querySelector(".med-kind").textContent = item.group;
    row.querySelector(".med-title").textContent = item.name || item.condition_name || "Health item";
    row.querySelector(".med-meta").textContent = [item.dose, item.frequency, item.timing, item.status, item.safety_status].filter(Boolean).join(" · ") || item.notes || item.reason || "Saved in the health profile";
    medicationList.append(row);
  }
}

function reportPipelineState(report, ocrStatus) {
  const sourceType = report.source_type || "upload";
  const status = report.status || "saved";
  const hasMetrics = Object.keys(report.metrics || {}).length > 0;
  const normalizedOcr = ocrStatus || (sourceType === "pasted_report" || hasMetrics ? "completed" : "queued");
  const parserPending = status === "parser_pending";
  const ocrDone = ["completed", "not_required"].includes(normalizedOcr) || sourceType === "pasted_report" || hasMetrics;
  const ocrActive = ["queued", "processing"].includes(normalizedOcr);
  const ocrFailed = normalizedOcr === "failed";

  if (ocrFailed) {
    return {
      state: "blocked",
      activeStep: 1,
      progress: 38,
      badge: "OCR needs review",
      detail: "The file is saved, but automatic reading failed. Re-upload or review is needed.",
      stages: ["Saved", "OCR", "Extract", "Memory"]
    };
  }

  if (ocrActive && !ocrDone) {
    return {
      state: "active",
      activeStep: 1,
      progress: normalizedOcr === "processing" ? 48 : 34,
      badge: normalizedOcr === "processing" ? "OCR reading now" : "OCR queued",
      detail: "The file is saved. Local reading is running or waiting before structured extraction.",
      stages: ["Saved", "OCR", "Extract", "Memory"]
    };
  }

  if (parserPending) {
    return {
      state: "active",
      activeStep: 2,
      progress: 72,
      badge: "Extraction pending",
      detail: "The file is saved and readable. Structured marker extraction has not finished yet.",
      stages: ["Saved", "OCR", "Extract", "Memory"]
    };
  }

  return {
    state: "complete",
    activeStep: 3,
    progress: 100,
    badge: "Complete",
    detail: "The report is saved and available in memory.",
    stages: ["Saved", "OCR", "Extract", "Memory"]
  };
}

function renderReportPipeline(pipeline) {
  const wrapper = document.createElement("div");
  wrapper.className = `report-pipeline ${pipeline.state}`;
  wrapper.style.setProperty("--pipeline-progress", `${pipeline.progress}%`);
  const steps = pipeline.stages
    .map((label, index) => {
      const stepState = pipeline.state === "complete" || index < pipeline.activeStep ? "done" : index === pipeline.activeStep ? pipeline.state : "pending";
      return `<span class="pipeline-step ${stepState}"><span class="pipeline-dot"></span><span>${label}</span></span>`;
    })
    .join("");
  wrapper.innerHTML = `
    <div class="pipeline-track" aria-hidden="true"><span></span></div>
    <div class="pipeline-steps">${steps}</div>
    <div class="pipeline-detail"></div>
  `;
  wrapper.querySelector(".pipeline-detail").textContent = pipeline.detail;
  return wrapper;
}

function renderDocuments(target, docs, emptyText) {
  if (!target) return;
  target.innerHTML = "";
  if (!docs.length) {
    target.innerHTML = `<div class="empty-row">${emptyText}</div>`;
    return;
  }
  for (const doc of docs) {
    const row = document.createElement("div");
    row.className = `doc-row${doc.id ? " clickable" : ""}`;
    row.innerHTML = `
      <div class="doc-title"></div>
      <div class="doc-meta"></div>
      <div class="doc-state"></div>
    `;
    row.querySelector(".doc-title").textContent = doc.title || doc.id;
    row.querySelector(".doc-meta").textContent = `${documentKindLabel(doc)} · ${doc.metadata?.bytes ? formatBytes(doc.metadata.bytes) : doc.document_type || "file"} · ${timeLabel(doc.created_at)}`;
    row.querySelector(".doc-state").textContent = documentOcrLabel(doc);
    if (doc.id) row.addEventListener("click", () => openDocumentPreview(doc));
    target.append(row);
  }
}

function uploadStatusLabel(result) {
  if (!result) return "Ready to save";
  if (result.status === "uploading") return "Saving";
  if (result.status === "failed") return "Failed";
  if (result.duplicate) return "Already saved";
  if (result.ocr_status === "queued") return "Saved · OCR queued";
  if (result.ocr_status === "processing") return "Saved · OCR reading";
  if (result.ocr_status === "completed") return "Saved · OCR complete";
  return "Saved";
}

function renderSelectedFiles() {
  if (!selectedFilesList) return;
  clearSelectedFiles.disabled = selectedFiles.length === 0;
  filePickerSummary.textContent = selectedFiles.length
    ? `${selectedFiles.length} selected file${selectedFiles.length === 1 ? "" : "s"} · ${formatBytes(selectedFiles.reduce((total, file) => total + file.size, 0))}`
    : "No files selected.";
  selectedFilesList.innerHTML = "";
  selectedFilesList.classList.toggle("empty", selectedFiles.length === 0);
  if (!selectedFiles.length) {
    selectedFilesList.textContent = "Choose files and they will appear here before saving.";
    return;
  }
  selectedFiles.forEach((file, index) => {
    const status = selectedFileStatuses.get(fileKey(file));
    const row = document.createElement("article");
    row.className = `selected-file-row${status?.status === "failed" ? " failed" : status ? " saved" : ""}`;
    row.innerHTML = `
      <div class="selected-file-index">${index + 1}</div>
      <div class="selected-file-main">
        <div class="selected-file-name"></div>
        <div class="selected-file-meta"></div>
      </div>
      <div class="selected-file-status"></div>
    `;
    row.querySelector(".selected-file-name").textContent = file.name;
    row.querySelector(".selected-file-meta").textContent = `${fileKindLabel(file)} · ${formatBytes(file.size)}`;
    row.querySelector(".selected-file-status").textContent = uploadStatusLabel(status);
    selectedFilesList.append(row);
  });
}

function setSelectedFiles(files) {
  selectedFiles = files;
  selectedFileStatuses = new Map();
  renderSelectedFiles();
}

function clearSelectedFileSelection() {
  selectedFiles = [];
  selectedFileStatuses = new Map();
  fileInput.value = "";
  uploadMessage.textContent = "";
  renderSelectedFiles();
}

function markSelectedFilesUploading(files) {
  selectedFileStatuses = new Map(files.map((file) => [fileKey(file), { status: "uploading" }]));
  renderSelectedFiles();
}

function markSelectedFileResults(files, results = []) {
  selectedFileStatuses = new Map();
  files.forEach((file, index) => {
    const byIndex = results[index];
    const byName = results.find((item) => [item.file_name, item.filename, item.original_name, item.title, item.name].includes(file.name));
    selectedFileStatuses.set(fileKey(file), byName || byIndex || { status: "saved" });
  });
  renderSelectedFiles();
}

function mergeFilesIntoSelection(files) {
  const unique = new Map(selectedFiles.map((file) => [fileKey(file), file]));
  files.forEach((file) => unique.set(fileKey(file), file));
  selectedFiles = Array.from(unique.values());
  selectedFileStatuses = new Map();
  renderSelectedFiles();
}

function setDebug(payload) {
  debugBox.textContent = JSON.stringify(payload, null, 2);
}

function clearSensitiveUi() {
  bootstrap = null;
  conversations = [];
  currentConversationId = null;
  latestDashboardData = null;
  selectedFiles = [];
  selectedFileStatuses = new Map();
  for (const node of [
    pinnedConversations,
    conversationList,
    messages,
    documentsEl,
    settingsDocumentsEl,
    reportList,
    selectedFilesList,
    usersList,
    healthSignalGrid,
    riskAlertsList,
    nextActionsList,
    labTrendList,
    medicationList,
    protocolMini,
    protocolSections
  ]) {
    if (node) node.innerHTML = "";
  }
  if (profileName) profileName.textContent = "T-PER-PRJ-HEALTH";
  if (profileSub) profileSub.textContent = "T-OS Personal Health Brain";
  if (projectCode) projectCode.textContent = "T-PER-PRJ-HEALTH";
  if (debugBox) debugBox.textContent = "{}";
  if (adminPanel) adminPanel.classList.add("hidden");
  document.querySelectorAll(".admin-only").forEach((node) => node.classList.add("hidden"));
}

function showLogin(message = "Sign in to continue") {
  clearSensitiveUi();
  document.body.classList.add("auth-locked");
  loginPanel.classList.remove("hidden");
  appPanel.classList.add("hidden");
  document.querySelector("#mobileTabs")?.classList.add("hidden");
  loginMessage.textContent = message;
  setStatus("pending", message);
}

function showApp() {
  document.body.classList.remove("auth-locked");
  loginPanel.classList.add("hidden");
  appPanel.classList.remove("hidden");
  document.querySelector("#mobileTabs")?.classList.remove("hidden");
  loginMessage.textContent = "";
}

function addMessage(type, text, meta = "") {
  const item = document.createElement("article");
  item.className = `message ${type}`;
  const content = document.createElement("div");
  content.className = "message-content";
  content.textContent = text;
  const time = document.createElement("div");
  time.className = "message-time";
  time.textContent = meta || new Date().toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit" });
  item.append(content, time);
  messages.append(item);
  messages.scrollTop = messages.scrollHeight;
  return item;
}

function addAttachmentMessage(files, state = "uploading") {
  const item = document.createElement("article");
  item.className = "message user attachment-message";
  const content = document.createElement("div");
  content.className = "attachment-stack";
  const time = document.createElement("div");
  time.className = "message-time";
  time.textContent = state === "uploading" ? "Uploading" : "Attached file";
  item.append(content, time);
  messages.append(item);
  renderAttachmentCards(item, files, [], state);
  messages.scrollTop = messages.scrollHeight;
  return item;
}

function renderAttachmentCards(item, files, results = [], state = "ready") {
  const content = item.querySelector(".attachment-stack");
  const time = item.querySelector(".message-time");
  content.innerHTML = "";
  files.forEach((file, index) => {
    const result = resultForFile(file, results, index);
    const savedDocument = resultDocument(result);
    const kind = savedDocument ? documentKindLabel(savedDocument) : fileKindLabel(file);
    const card = document.createElement("section");
    card.className = `attachment-card ${result?.status === "failed" ? "failed" : savedDocument ? "saved" : "pending"}`;
    const icon = document.createElement("div");
    icon.className = "attachment-icon";
    icon.textContent = kind === "Image" ? "IMG" : kind;
    const body = document.createElement("div");
    body.className = "attachment-body";
    const title = document.createElement("div");
    title.className = "attachment-title";
    title.textContent = savedDocument?.title || file.name;
    const meta = document.createElement("div");
    meta.className = "attachment-meta";
    meta.textContent = `${kind} · ${formatBytes(file.size || savedDocument?.metadata?.bytes || 0)}`;
    const notes = document.createElement("div");
    notes.className = "attachment-notes";
    const statusNote = document.createElement("span");
    statusNote.textContent = uploadVisualStatus(result, state);
    notes.append(statusNote);
    if (savedDocument?.id) {
      const memoryNote = document.createElement("span");
      memoryNote.textContent = "Saved to memory";
      notes.append(memoryNote);
    }
    body.append(title, meta, notes);
    const actions = document.createElement("div");
    actions.className = "attachment-actions";
    if (savedDocument?.id) {
      const preview = document.createElement("button");
      preview.type = "button";
      preview.className = "attachment-preview";
      preview.textContent = "Preview";
      preview.addEventListener("click", () => openDocumentPreview(savedDocument));
      actions.append(preview);
    }
    card.append(icon, body, actions);
    content.append(card);
  });
  time.textContent = results.length ? "Saved" : state === "uploading" ? "Uploading" : "Attached file";
  messages.scrollTop = messages.scrollHeight;
}

function openDocumentPreview(savedDocument) {
  const previewUrl = documentPreviewUrl(savedDocument);
  if (!previewUrl) return;
  previewTitle.textContent = savedDocument.title || "Saved file";
  previewSubtitle.textContent = `${documentKindLabel(savedDocument)} · ${documentOcrLabel(savedDocument)}`;
  previewBody.innerHTML = "";
  const isImage = savedDocument.document_type === "image_report";
  const viewer = document.createElement(isImage ? "img" : "iframe");
  viewer.className = isImage ? "preview-image" : "preview-frame";
  viewer.src = previewUrl;
  if (!isImage) viewer.title = savedDocument.title || "preview";
  previewBody.append(viewer);
  documentPreviewModal.classList.remove("hidden");
  documentPreviewModal.setAttribute("aria-hidden", "false");
}

function closeDocumentPreview() {
  documentPreviewModal.classList.add("hidden");
  documentPreviewModal.setAttribute("aria-hidden", "true");
  previewBody.innerHTML = "";
}

function startProgressMessage(item, stages) {
  const content = item.querySelector(".message-content");
  const time = item.querySelector(".message-time");
  const startedAt = Date.now();
  let stageIndex = 0;
  const render = () => {
    const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    const stage = stages[Math.min(stageIndex, stages.length - 1)];
    content.textContent = `${stage}\n${stageIndex + 1}/${stages.length} · ${elapsed}s`;
    time.textContent = "Working";
    stageIndex = Math.min(stageIndex + 1, stages.length - 1);
  };
  render();
  const interval = setInterval(render, 1800);
  return () => clearInterval(interval);
}

function renderEmptyThread() {
  messages.innerHTML = "";
  addMessage(
    "system",
    "Start a new consultation. Ask a general question, paste a report, or upload lab files. Each consultation is saved into structured memory.",
    "Ready"
  );
}

function renderMessages(rows) {
  messages.innerHTML = "";
  if (!rows.length) {
    renderEmptyThread();
    return;
  }
  for (const row of rows) {
    addMessage(row.role === "user" ? "user" : "system", row.body, row.metadata?.validator_status?.status || timeLabel(row.created_at));
  }
}

function renderConversationList() {
  const query = conversationSearch.value.trim().toLowerCase();
  const visible = conversations.filter((item) => !query || item.title.toLowerCase().includes(query) || (item.summary || "").toLowerCase().includes(query));
  const pinned = visible.filter((item) => item.pinned);
  const regular = visible.filter((item) => !item.pinned);

  renderConversationBucket(pinnedConversations, pinned, "No pinned consultations.");
  renderConversationBucket(conversationList, regular, "No saved consultations.");
}

function renderConversationBucket(target, rows, emptyText) {
  target.innerHTML = "";
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = emptyText;
    target.append(empty);
    return;
  }
  for (const conversation of rows) {
    const row = document.createElement("button");
    row.className = `conversation-row${conversation.id === currentConversationId ? " active" : ""}`;
    row.type = "button";
    row.innerHTML = `
      <span class="conversation-main">
        <span class="conversation-title"></span>
        <span class="conversation-meta"></span>
      </span>
      <span class="pin-dot" title="Pin"></span>
    `;
    row.querySelector(".conversation-title").textContent = conversation.title || "Health consultation";
    row.querySelector(".conversation-meta").textContent = `${timeLabel(conversation.last_message_at || conversation.created_at)} · ${conversation.message_count || 0} message${conversation.message_count === 1 ? "" : "s"}`;
    row.querySelector(".pin-dot").textContent = conversation.pinned ? "●" : "○";
    row.addEventListener("click", () => openConversation(conversation.id));
    row.querySelector(".pin-dot").addEventListener("click", async (event) => {
      event.stopPropagation();
      await togglePin(conversation.id, !conversation.pinned);
    });
    target.append(row);
  }
}

async function loadGoogleStatus() {
  const status = await api("/api/auth/google/status").catch(() => ({ enabled: false }));
  if (status.enabled) {
    googleLogin.classList.remove("disabled");
    oauthNote.textContent = "Google Login is enabled for this domain.";
  } else {
    googleLogin.classList.add("disabled");
    googleLogin.addEventListener("click", (event) => event.preventDefault(), { once: true });
    oauthNote.textContent = "Google Login is waiting for the domain OAuth configuration.";
  }
}

async function loadConversations({ openLatest = false } = {}) {
  const data = await api("/api/conversations");
  conversations = data.conversations || [];
  if (openLatest && conversations.length && !currentConversationId) {
    currentConversationId = conversations[0].id;
    await openConversation(currentConversationId, { skipListReload: true });
  } else {
    renderConversationList();
    updatePinButton();
  }
}

async function openConversation(id, options = {}) {
  currentConversationId = id;
  const data = await api(`/api/conversations/${id}/messages`);
  renderMessages(data.messages || []);
  viewTitle.textContent = data.conversation?.title || "Clinical chat";
  if (!options.skipListReload) await loadConversations();
  renderConversationList();
  setView("chat");
}

async function createConversation() {
  const data = await api("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ title: "New health consultation" })
  });
  currentConversationId = data.conversation.id;
  renderEmptyThread();
  await loadConversations();
  setView("chat");
}

async function togglePin(id, pinned) {
  await api(`/api/conversations/${id}`, { method: "PATCH", body: JSON.stringify({ pinned }) });
  await loadConversations();
  updatePinButton();
}

function updatePinButton() {
  const current = conversations.find((item) => item.id === currentConversationId);
  pinCurrentButton.textContent = current?.pinned ? "Pinned" : "Pin";
  pinCurrentButton.disabled = !current;
}

async function loadDashboard() {
  if (dashboardRefreshInFlight) return;
  dashboardRefreshInFlight = true;
  try {
    const data = await api("/api/dashboard");
    latestDashboardData = data;
    reportsCount.textContent = data.stats?.reports ?? 0;
    documentsCount.textContent = data.stats?.documents ?? 0;
    memoryCount.textContent = data.stats?.lab_markers ?? data.stats?.recent_memory_events ?? 0;
    if (profileSummary) {
      const latestReport = data.latest_report?.title ? ` · Latest report: ${data.latest_report.title}` : "";
      profileSummary.textContent = `${data.stats?.documents ?? 0} files · ${data.stats?.reports ?? 0} reports · ${data.stats?.lab_markers ?? 0} markers · ${data.stats?.medications ?? 0} meds${latestReport}`;
    }

    renderHealthSignals(data.health_signals || []);
    renderRiskAlerts(data.risk_alerts || []);
    renderNextActions(data.next_actions || []);
    renderLabTrends(data.marker_trends || data.lab_trends || []);
    renderProtocolMini(data.protocol_snapshot || {});
    renderProtocolSections(data.protocol_snapshot || {});
    renderMedicationList(data.medications || [], data.supplements || [], data.conditions || []);
    renderDocuments(settingsDocumentsEl, data.documents || [], "No saved files yet.");
  } finally {
    dashboardRefreshInFlight = false;
  }
}

async function refreshDashboardQuietly() {
  try {
    await loadDashboard();
  } catch {
    dashboardRefreshInFlight = false;
  }
}

async function loadProtocol() {
  if (latestDashboardData?.protocol_snapshot) {
    renderProtocolSections(latestDashboardData.protocol_snapshot);
    return;
  }
  const data = await api("/api/protocol");
  latestDashboardData = { ...(latestDashboardData || {}), protocol_snapshot: data.protocol_snapshot };
  renderProtocolSections(data.protocol_snapshot || {});
}

async function loadUsers() {
  if (!bootstrap?.auth?.is_admin) return;
  const data = await api("/api/admin/users");
  usersList.innerHTML = "";
  for (const user of data.users) {
    const row = document.createElement("div");
    row.className = "user-row";
    row.innerHTML = `
      <div>
        <div class="user-email"></div>
        <div class="user-meta"></div>
      </div>
      <button type="button" class="approve-button">Approve</button>
    `;
    row.querySelector(".user-email").textContent = user.email;
    row.querySelector(".user-meta").textContent = `${user.status} · ${user.role} · ${user.person_slug || "unmapped"}`;
    const approve = row.querySelector(".approve-button");
    approve.hidden = user.status === "active";
    approve.addEventListener("click", async () => {
      await api(`/api/admin/users/${user.id}/approve`, {
        method: "POST",
        body: JSON.stringify({ person_slug: "tareq", role: "member" })
      });
      await loadUsers();
    });
    usersList.append(row);
  }
}

async function loadBootstrap() {
  try {
    bootstrap = await api("/api/bootstrap");
    const targetView = requestedView();
    showApp();
    profileName.textContent = bootstrap.auth?.email || bootstrap.project_code || bootstrap.person_slug;
    profileSub.textContent = bootstrap.auth?.is_admin ? `${bootstrap.display_name || "T-OS Personal Health Brain"} · Admin` : `${bootstrap.display_name || "T-OS Personal Health Brain"} · Member`;
    if (projectCode) projectCode.textContent = bootstrap.project_code || "T-PER-PRJ-HEALTH";
    document.querySelectorAll(".admin-only").forEach((node) => node.classList.toggle("hidden", !bootstrap.auth?.is_admin));
    adminPanel.classList.toggle("hidden", !bootstrap.auth?.is_admin);
    setStatus(
      bootstrap.hmdb_ready && bootstrap.n8n_health_committee ? "ok" : "pending",
      bootstrap.n8n_health_committee ? "Health committee and memory are connected" : "Memory is connected · committee is staged"
    );
    renderEmptyThread();
    await Promise.all([loadConversations({ openLatest: targetView === "chat" }), loadDashboard(), loadUsers()]);
    if (targetView !== "chat") setView(targetView, { remember: false });
  } catch {
    showLogin("Sign in to continue");
  }
}

async function submitChat() {
  if (chatSubmitting) return;
  const userMessage = questionInput.value.trim();
  if (!userMessage) return;
  chatSubmitting = true;
  addMessage("user", userMessage);
  questionInput.value = "";
  const working = addMessage("system", "Passing the question through the Health Committee...", "");
  const stopProgress = startProgressMessage(working, [
    "Saving the question",
    "Loading health memory",
    "Routing to the health committee",
    "Applying safety rules",
    "Saving updates and preparing the answer"
  ]);
  try {
    const data = await api("/api/health/chat", {
      method: "POST",
      body: JSON.stringify({ user_message: userMessage, conversation_id: currentConversationId })
    });
    stopProgress();
    working.remove();
    currentConversationId = data.conversation_id;
    const meta = data.captured_report ? "Report saved" : data.validator_status?.status ? `validator: ${data.validator_status.status}` : "";
    addMessage("system", data.answer || "No response returned.", meta);
    setDebug({
      request_id: data.request_id,
      conversation_id: data.conversation_id,
      captured_report: data.captured_report,
      validator_status: data.validator_status,
      models_used: data.models_used,
      n8n: data.n8n
    });
    await Promise.all([loadConversations(), loadDashboard()]);
  } catch (error) {
    stopProgress();
    working.remove();
    addMessage("system", `Request failed: ${error.message}`);
  } finally {
    chatSubmitting = false;
  }
}

async function uploadCurrentFile(filesOverride = null, options = {}) {
  const files = filesOverride ? Array.from(filesOverride) : selectedFiles.length ? selectedFiles : Array.from(fileInput.files || []);
  if (!files.length) {
    uploadMessage.textContent = "Choose one or more files first.";
    renderSelectedFiles();
    return;
  }
  selectedFiles = files;
  markSelectedFilesUploading(files);
  const showChatAttachment = options.source === "chat" || currentView === "chat";
  const attachmentMessage = showChatAttachment ? addAttachmentMessage(files, "uploading") : null;
  const form = new FormData();
  if (currentConversationId) form.append("conversation_id", currentConversationId);
  for (const file of files) form.append("files", file);
  uploadMessage.textContent = `Saving ${files.length} file${files.length === 1 ? "" : "s"} into HMDB...`;
  const uploadProgress = showChatAttachment ? addMessage("system", `Saving ${files.length} file${files.length === 1 ? "" : "s"}...`, "") : null;
  const stopProgress = uploadProgress
    ? startProgressMessage(uploadProgress, [
        "Uploading files to private memory",
        "Registering files in the database",
        "Running local OCR for images and PDFs",
        "Refreshing the dashboard"
      ])
    : () => {};
  try {
    const data = await api("/api/documents", { method: "POST", body: form });
    const failed = data.results?.filter((item) => item.status === "failed").length || 0;
    const duplicates = data.results?.filter((item) => item.duplicate).length || 0;
    const queuedOcr = data.results?.filter((item) => item.ocr_status === "queued").length || 0;
    stopProgress();
    markSelectedFileResults(files, data.results || []);
    if (attachmentMessage) renderAttachmentCards(attachmentMessage, files, data.results || [], failed ? "failed" : "saved");
    uploadMessage.textContent = "Saved. Refreshing the file list...";
    await loadDashboard();
    uploadMessage.textContent =
      failed > 0
        ? `${data.saved || 0} file${(data.saved || 0) === 1 ? "" : "s"} saved, ${failed} failed. Successful files are visible in the saved list.`
        : duplicates > 0
          ? `Saved · ${duplicates} file${duplicates === 1 ? "" : "s"} already existed. The list below is refreshed from the database.`
          : `${data.saved || files.length} file${(data.saved || files.length) === 1 ? "" : "s"} saved. ${queuedOcr ? `OCR is running on ${queuedOcr} file${queuedOcr === 1 ? "" : "s"}.` : "Text is saved."}`;
    if (uploadProgress) {
      uploadProgress.querySelector(".message-content").textContent =
        failed > 0
          ? `${data.saved || 0} file${(data.saved || 0) === 1 ? "" : "s"} saved, ${failed} failed. Review the dashboard for details.`
          : `${data.saved || files.length} file${(data.saved || files.length) === 1 ? "" : "s"} saved into memory.${queuedOcr ? `\nLocal OCR started on ${queuedOcr} file${queuedOcr === 1 ? "" : "s"}; the dashboard refreshes when it completes.` : ""}`;
      uploadProgress.querySelector(".message-time").textContent = "Saved";
    }
    fileInput.value = "";
  } catch (error) {
    stopProgress();
    uploadMessage.textContent = error.message;
    selectedFileStatuses = new Map(files.map((file) => [fileKey(file), { status: "failed" }]));
    renderSelectedFiles();
    if (attachmentMessage) renderAttachmentCards(attachmentMessage, files, files.map((file) => ({ status: "failed", filename: file.name })), "failed");
    if (uploadProgress) {
      uploadProgress.querySelector(".message-content").textContent = `Upload failed: ${error.message}`;
      uploadProgress.querySelector(".message-time").textContent = "Failed";
    }
  }
}

function setView(view, options = {}) {
  const nextView = VALID_VIEWS.has(view) ? view : "chat";
  currentView = nextView;
  if (options.remember !== false) {
    safeSessionSet(VIEW_STATE_KEY, nextView);
    const nextHash = nextView === "chat" ? "" : `#${nextView}`;
    if (location.hash !== nextHash) history.replaceState(null, "", `${location.pathname}${location.search}${nextHash}`);
  }
  document.querySelectorAll(".view-pane").forEach((pane) => pane.classList.remove("active"));
  document.querySelector(`#${nextView}View`)?.classList.add("active");
  document.querySelectorAll(".rail-button").forEach((button) => button.classList.toggle("active", button.dataset.view === nextView));
  viewTitle.textContent =
    nextView === "dashboard"
      ? "Dashboard"
      : nextView === "protocol"
        ? "Treatment protocol"
        : nextView === "settings"
          ? "Reports & files"
          : nextView === "admin"
            ? "Admin"
            : "Clinical chat";
  pinCurrentButton.classList.toggle("hidden", nextView !== "chat");
  if (nextView === "dashboard" || nextView === "settings" || nextView === "protocol") refreshDashboardQuietly();
  if (nextView === "protocol") loadProtocol().catch(() => {});
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginMessage.textContent = "Checking...";
  try {
    await api("/api/login", { method: "POST", body: JSON.stringify({ accessCode: document.querySelector("#accessCode").value }) });
    loginMessage.textContent = "";
    await loadBootstrap();
  } catch (error) {
    loginMessage.textContent = error.message;
  }
});

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await submitChat();
});

questionInput.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  await submitChat();
});

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await uploadCurrentFile();
});

fileInput.addEventListener("change", () => {
  const files = Array.from(fileInput.files || []);
  setSelectedFiles(files);
  if (files.length && currentView === "chat") uploadCurrentFile(files, { source: "chat" });
});

filePickerButton.addEventListener("click", () => fileInput.click());
clearSelectedFiles.addEventListener("click", clearSelectedFileSelection);

for (const eventName of ["dragenter", "dragover"]) {
  filePickerButton.addEventListener(eventName, (event) => {
    event.preventDefault();
    filePickerButton.classList.add("dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  filePickerButton.addEventListener(eventName, () => filePickerButton.classList.remove("dragging"));
}
filePickerButton.addEventListener("drop", (event) => {
  event.preventDefault();
  event.stopPropagation();
  mergeFilesIntoSelection(Array.from(event.dataTransfer?.files || []));
});

function hasFileDrag(event) {
  return Array.from(event.dataTransfer?.types || []).includes("Files");
}

function setChatDropVisible(visible) {
  chatDropOverlay?.classList.toggle("hidden", !visible);
  chatView?.classList.toggle("dragging-file", visible);
}

async function uploadDroppedFiles(files) {
  const uploadFiles = Array.from(files || []);
  if (!uploadFiles.length) return;
  dragDepth = 0;
  setChatDropVisible(false);
  setView("chat");
  setSelectedFiles(uploadFiles);
  await uploadCurrentFile(uploadFiles, { source: "chat" });
}

document.addEventListener("dragenter", (event) => {
  if (!hasFileDrag(event) || appPanel.classList.contains("hidden")) return;
  event.preventDefault();
  dragDepth += 1;
  setChatDropVisible(true);
});

document.addEventListener("dragover", (event) => {
  if (!hasFileDrag(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
});

document.addEventListener("dragleave", (event) => {
  if (!hasFileDrag(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) setChatDropVisible(false);
});

document.addEventListener("drop", async (event) => {
  if (!hasFileDrag(event)) return;
  event.preventDefault();
  event.stopPropagation();
  await uploadDroppedFiles(event.dataTransfer?.files || []);
});

previewClose.addEventListener("click", closeDocumentPreview);
previewBackdrop.addEventListener("click", closeDocumentPreview);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !documentPreviewModal.classList.contains("hidden")) closeDocumentPreview();
});

addUserForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = document.querySelector("#newUserEmail").value.trim();
  const role = document.querySelector("#newUserRole").value;
  if (!email) return;
  await api("/api/admin/users", {
    method: "POST",
    body: JSON.stringify({ email, role, person_slug: "tareq", status: "active" })
  });
  document.querySelector("#newUserEmail").value = "";
  await loadUsers();
});

uploadReportsButton.addEventListener("click", () => {
  setView("settings");
});

printProtocolButton?.addEventListener("click", () => {
  setView("protocol");
  window.setTimeout(() => window.print(), 80);
});

document.querySelectorAll(".rail-button").forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.view));
});

document.querySelector("#composerAttach").addEventListener("click", () => fileInput.click());
document.querySelector("#newChatButton").addEventListener("click", createConversation);
document.querySelector("#mobileNewChatButton").addEventListener("click", createConversation);
conversationSearch.addEventListener("input", renderConversationList);
pinCurrentButton.addEventListener("click", async () => {
  const current = conversations.find((item) => item.id === currentConversationId);
  if (!current) return;
  await togglePin(current.id, !current.pinned);
});

setInterval(() => {
  if ((currentView === "dashboard" || currentView === "settings" || currentView === "protocol") && !appPanel.classList.contains("hidden")) {
    refreshDashboardQuietly();
  }
}, 8000);

if (new URLSearchParams(location.search).get("auth") === "pending") {
  loginMessage.textContent = "Signed in with Google. Waiting for admin approval.";
}

await loadGoogleStatus();
const reloadLocked = await enforceReloadLock();
if (!reloadLocked) await loadBootstrap();
