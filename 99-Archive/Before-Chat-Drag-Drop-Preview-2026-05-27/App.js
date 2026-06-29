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
const pinnedConversations = document.querySelector("#pinnedConversations");
const conversationList = document.querySelector("#conversationList");
const conversationSearch = document.querySelector("#conversationSearch");
const pinCurrentButton = document.querySelector("#pinCurrentButton");
const viewTitle = document.querySelector("#viewTitle");
const reportsCount = document.querySelector("#reportsCount");
const documentsCount = document.querySelector("#documentsCount");
const memoryCount = document.querySelector("#memoryCount");

let bootstrap = null;
let conversations = [];
let currentConversationId = null;
let debugEnabled = false;
let currentView = "chat";
let chatSubmitting = false;
let dashboardRefreshInFlight = false;
let selectedFiles = [];
let selectedFileStatuses = new Map();

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
  return date.toLocaleDateString("ar-SA", { month: "short", day: "numeric" });
}

function formatBytes(bytes = 0) {
  if (!bytes) return "0 بايت";
  const units = ["بايت", "كيلوبايت", "ميجابايت", "جيجابايت"];
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
  if (/\.(png|jpg|jpeg|heic|webp)$/i.test(name)) return "صورة";
  if (/\.(md|txt)$/i.test(name)) return "نص";
  if (name.endsWith(".csv")) return "CSV";
  return file.type || "ملف";
}

function documentOcrLabel(doc) {
  const ocr = doc.metadata?.ocr?.status;
  if (ocr === "completed") return "OCR مكتمل";
  if (ocr === "processing") return "OCR يقرأ";
  if (ocr === "queued") return "OCR بالانتظار";
  if (ocr === "failed") return "OCR فشل";
  return "محفوظ";
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
      badge: "OCR يحتاج مراجعة",
      detail: "الملف محفوظ، لكن القراءة الآلية فشلت وتحتاج إعادة رفع أو مراجعة.",
      stages: ["حفظ", "قراءة", "تحليل", "ذاكرة"]
    };
  }

  if (ocrActive && !ocrDone) {
    return {
      state: "active",
      activeStep: 1,
      progress: normalizedOcr === "processing" ? 48 : 34,
      badge: normalizedOcr === "processing" ? "OCR يقرأ الآن" : "OCR بالانتظار",
      detail: "الملف محفوظ. القراءة المحلية تعمل أو تنتظر دورها قبل التحليل.",
      stages: ["حفظ", "قراءة", "تحليل", "ذاكرة"]
    };
  }

  if (parserPending) {
    return {
      state: "active",
      activeStep: 2,
      progress: 72,
      badge: "بانتظار التحليل",
      detail: "الملف محفوظ ومقروء. التحليل البنيوي للقيم لم يكتمل بعد.",
      stages: ["حفظ", "قراءة", "تحليل", "ذاكرة"]
    };
  }

  return {
    state: "complete",
    activeStep: 3,
    progress: 100,
    badge: "مكتمل",
    detail: "التقرير محفوظ ومتاح في الذاكرة.",
    stages: ["حفظ", "قراءة", "تحليل", "ذاكرة"]
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
    row.className = "doc-row";
    row.innerHTML = `
      <div class="doc-title"></div>
      <div class="doc-meta"></div>
      <div class="doc-state"></div>
    `;
    row.querySelector(".doc-title").textContent = doc.title || doc.id;
    row.querySelector(".doc-meta").textContent = `${doc.document_type || "file"} · ${timeLabel(doc.created_at)}`;
    row.querySelector(".doc-state").textContent = documentOcrLabel(doc);
    target.append(row);
  }
}

function uploadStatusLabel(result) {
  if (!result) return "جاهز للحفظ";
  if (result.status === "uploading") return "جاري الحفظ";
  if (result.status === "failed") return "فشل";
  if (result.duplicate) return "محفوظ مسبقاً";
  if (result.ocr_status === "queued") return "محفوظ · OCR بالانتظار";
  if (result.ocr_status === "processing") return "محفوظ · OCR يقرأ";
  if (result.ocr_status === "completed") return "محفوظ · OCR مكتمل";
  return "محفوظ";
}

function renderSelectedFiles() {
  if (!selectedFilesList) return;
  clearSelectedFiles.disabled = selectedFiles.length === 0;
  filePickerSummary.textContent = selectedFiles.length
    ? `${selectedFiles.length} ملفات مختارة · ${formatBytes(selectedFiles.reduce((total, file) => total + file.size, 0))}`
    : "ما فيه ملفات مختارة.";
  selectedFilesList.innerHTML = "";
  selectedFilesList.classList.toggle("empty", selectedFiles.length === 0);
  if (!selectedFiles.length) {
    selectedFilesList.textContent = "اختر ملفات، وراح تظهر هنا قبل الحفظ.";
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

function showApp() {
  loginPanel.classList.add("hidden");
  appPanel.classList.remove("hidden");
  document.querySelector("#mobileTabs").classList.remove("hidden");
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

function startProgressMessage(item, stages) {
  const content = item.querySelector(".message-content");
  const time = item.querySelector(".message-time");
  const startedAt = Date.now();
  let stageIndex = 0;
  const render = () => {
    const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    const stage = stages[Math.min(stageIndex, stages.length - 1)];
    content.textContent = `${stage}\n${stageIndex + 1}/${stages.length} · ${elapsed}s`;
    time.textContent = "قيد التنفيذ";
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
    "ابدأ محادثة جديدة. تقدر تسأل سؤال عام، تلصق تقرير، أو ترفع ملف تحليل. كل محادثة تنحفظ وتدخل في الذاكرة المرتبة.",
    "جاهز"
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

  renderConversationBucket(pinnedConversations, pinned, "ما فيه محادثات مثبتة.");
  renderConversationBucket(conversationList, regular, "ما فيه محادثات محفوظة.");
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
      <span class="pin-dot" title="تثبيت"></span>
    `;
    row.querySelector(".conversation-title").textContent = conversation.title || "محادثة صحية";
    row.querySelector(".conversation-meta").textContent = `${timeLabel(conversation.last_message_at || conversation.created_at)} · ${conversation.message_count || 0} رسائل`;
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
    oauthNote.textContent = "Google Login مفعّل لهذا الدومين.";
  } else {
    googleLogin.classList.add("disabled");
    googleLogin.addEventListener("click", (event) => event.preventDefault(), { once: true });
    oauthNote.textContent = "Google Login جاهز وينتظر Client ID/Secret للدومين h.fc.sa.";
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
  viewTitle.textContent = data.conversation?.title || "المحادثة";
  if (!options.skipListReload) await loadConversations();
  renderConversationList();
  setView("chat");
}

async function createConversation() {
  const data = await api("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ title: "محادثة صحية جديدة" })
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
  pinCurrentButton.textContent = current?.pinned ? "مثبتة" : "تثبيت";
  pinCurrentButton.disabled = !current;
}

async function loadDashboard() {
  if (dashboardRefreshInFlight) return;
  dashboardRefreshInFlight = true;
  const data = await api("/api/dashboard");
  reportsCount.textContent = data.stats?.reports ?? 0;
  documentsCount.textContent = data.stats?.documents ?? 0;
  memoryCount.textContent = data.stats?.recent_memory_events ?? 0;

  reportList.innerHTML = "";
  if (!data.reports?.length) {
    reportList.innerHTML = `<div class="empty-row">ارفع تقرير أو الصقه في الشات، وراح يظهر هنا.</div>`;
  } else {
    for (const report of data.reports) {
      const row = document.createElement("article");
      row.className = "report-row";
      const ocrStatus = report.trend?.ocr_status || report.trend?.ocr?.status;
      const pipeline = reportPipelineState(report, ocrStatus);
      const metrics = Object.entries(report.metrics || {})
        .slice(0, 3)
        .map(([key, value]) => `${key}: ${value}`)
        .join(" · ");
      row.innerHTML = `
        <div class="report-top">
          <div class="report-title"></div>
          <div class="report-status"></div>
        </div>
        <div class="report-summary"></div>
        <div class="report-pipeline-slot"></div>
        <div class="report-meta"></div>
      `;
      row.dataset.pipelineState = pipeline.state;
      row.querySelector(".report-title").textContent = report.title;
      const statusNode = row.querySelector(".report-status");
      statusNode.textContent = pipeline.badge;
      statusNode.dataset.state = pipeline.state;
      row.querySelector(".report-summary").textContent = report.summary || "محفوظ في الذاكرة.";
      row.querySelector(".report-pipeline-slot").replaceWith(renderReportPipeline(pipeline));
      row.querySelector(".report-meta").textContent = `${report.source_type} · ${timeLabel(report.created_at)}${metrics ? ` · ${metrics}` : ""}`;
      reportList.append(row);
    }
  }

  renderDocuments(documentsEl, data.documents || [], "ما فيه ملفات محفوظة حتى الآن.");
  renderDocuments(settingsDocumentsEl, data.documents || [], "ما فيه ملفات محفوظة حتى الآن.");
  dashboardRefreshInFlight = false;
}

async function refreshDashboardQuietly() {
  try {
    await loadDashboard();
  } catch {
    dashboardRefreshInFlight = false;
  }
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
      <button type="button" class="approve-button">تفعيل</button>
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
    showApp();
    profileName.textContent = bootstrap.auth?.email || bootstrap.person_slug;
    profileSub.textContent = bootstrap.auth?.is_admin ? "Admin" : "Member";
    document.querySelectorAll(".admin-only").forEach((node) => node.classList.toggle("hidden", !bootstrap.auth?.is_admin));
    adminPanel.classList.toggle("hidden", !bootstrap.auth?.is_admin);
    setStatus(
      bootstrap.hmdb_ready && bootstrap.n8n_health_committee ? "ok" : "pending",
      bootstrap.n8n_health_committee ? "اللجنة الصحية + الذاكرة متصلين" : "الذاكرة متصلة · اللجنة قيد التجهيز"
    );
    renderEmptyThread();
    await Promise.all([loadConversations({ openLatest: true }), loadDashboard(), loadUsers()]);
  } catch {
    setStatus("pending", "سجل الدخول للمتابعة");
  }
}

async function submitChat() {
  if (chatSubmitting) return;
  const userMessage = questionInput.value.trim();
  if (!userMessage) return;
  chatSubmitting = true;
  addMessage("user", userMessage);
  questionInput.value = "";
  const working = addMessage("system", "جاري تمرير السؤال على Health Committee...", "");
  const stopProgress = startProgressMessage(working, [
    "حفظ السؤال في المحادثة",
    "تحميل الذاكرة الصحية",
    "تمريره إلى اللجنة الصحية",
    "تطبيق قواعد السلامة",
    "حفظ التحديثات وتجهيز الرد"
  ]);
  try {
    const data = await api("/api/health/chat", {
      method: "POST",
      body: JSON.stringify({ user_message: userMessage, conversation_id: currentConversationId })
    });
    stopProgress();
    working.remove();
    currentConversationId = data.conversation_id;
    const meta = data.captured_report ? "تقرير محفوظ" : data.validator_status?.status ? `validator: ${data.validator_status.status}` : "";
    addMessage("system", data.answer || "ما رجع رد.", meta);
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
    addMessage("system", `تعذر تنفيذ الطلب: ${error.message}`);
  } finally {
    chatSubmitting = false;
  }
}

async function uploadCurrentFile() {
  const files = selectedFiles.length ? selectedFiles : Array.from(fileInput.files || []);
  if (!files.length) {
    uploadMessage.textContent = "اختر ملف أو أكثر أولاً.";
    renderSelectedFiles();
    return;
  }
  selectedFiles = files;
  markSelectedFilesUploading(files);
  const form = new FormData();
  if (currentConversationId) form.append("conversation_id", currentConversationId);
  for (const file of files) form.append("files", file);
  uploadMessage.textContent = `جاري حفظ ${files.length} ملف داخل HMDB...`;
  const uploadProgress =
    currentView === "chat"
      ? addMessage("system", `جاري حفظ ${files.length} ملف...`, "")
      : null;
  const stopProgress = uploadProgress
    ? startProgressMessage(uploadProgress, [
        "رفع الملفات إلى الذاكرة الخاصة",
        "تسجيل الملفات في قاعدة البيانات",
        "تشغيل OCR محلي للصور و PDF",
        "تحديث الداشبورد"
      ])
    : () => {};
  try {
    const data = await api("/api/documents", { method: "POST", body: form });
    const failed = data.results?.filter((item) => item.status === "failed").length || 0;
    const duplicates = data.results?.filter((item) => item.duplicate).length || 0;
    const queuedOcr = data.results?.filter((item) => item.ocr_status === "queued").length || 0;
    stopProgress();
    markSelectedFileResults(files, data.results || []);
    uploadMessage.textContent = "تم الحفظ، جاري تحديث قائمة الملفات...";
    await loadDashboard();
    uploadMessage.textContent =
      failed > 0
        ? `تم حفظ ${data.saved || 0} ملف، وفشل ${failed}. الملفات الناجحة ظاهرة في القائمة المحفوظة.`
        : duplicates > 0
          ? `تم الحفظ · ${duplicates} ملف محفوظ مسبقاً. القائمة تحت محدثة من قاعدة البيانات.`
          : `تم حفظ ${data.saved || files.length} ملف. ${queuedOcr ? `OCR يعمل على ${queuedOcr} ملف.` : "النص محفوظ."}`;
    if (uploadProgress) {
      uploadProgress.querySelector(".message-content").textContent =
        failed > 0
          ? `تم حفظ ${data.saved || 0} ملف، وفشل ${failed}. راجع الداشبورد للتفاصيل.`
          : `تم حفظ ${data.saved || files.length} ملف في الذاكرة.${queuedOcr ? `\nOCR المحلي بدأ على ${queuedOcr} ملف، والداشبورد يتحدث عند اكتماله.` : ""}`;
      uploadProgress.querySelector(".message-time").textContent = "تم الحفظ";
    }
    fileInput.value = "";
  } catch (error) {
    stopProgress();
    uploadMessage.textContent = error.message;
    selectedFileStatuses = new Map(files.map((file) => [fileKey(file), { status: "failed" }]));
    renderSelectedFiles();
    if (uploadProgress) {
      uploadProgress.querySelector(".message-content").textContent = `تعذر رفع الملفات: ${error.message}`;
      uploadProgress.querySelector(".message-time").textContent = "فشل";
    }
  }
}

function setView(view) {
  currentView = view;
  document.querySelectorAll(".view-pane").forEach((pane) => pane.classList.remove("active"));
  document.querySelector(`#${view}View`)?.classList.add("active");
  document.querySelectorAll(".rail-button").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  viewTitle.textContent = view === "dashboard" ? "الداشبورد" : view === "settings" ? "الإعدادات" : view === "admin" ? "الأدمن" : "المحادثة";
  pinCurrentButton.classList.toggle("hidden", view !== "chat");
  if (view === "dashboard" || view === "settings") refreshDashboardQuietly();
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginMessage.textContent = "جاري التحقق...";
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
  setSelectedFiles(Array.from(fileInput.files || []));
  if (selectedFiles.length && currentView === "chat") uploadCurrentFile();
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
  mergeFilesIntoSelection(Array.from(event.dataTransfer?.files || []));
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
  if ((currentView === "dashboard" || currentView === "settings") && !appPanel.classList.contains("hidden")) {
    refreshDashboardQuietly();
  }
}, 8000);

if (new URLSearchParams(location.search).get("auth") === "pending") {
  loginMessage.textContent = "تم تسجيلك عبر Google، بانتظار موافقة الأدمن.";
}

await loadGoogleStatus();
await loadBootstrap();
