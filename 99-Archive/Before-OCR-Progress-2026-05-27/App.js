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
const uploadMessage = document.querySelector("#uploadMessage");
const documentsEl = document.querySelector("#documents");
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
        <div class="report-meta"></div>
      `;
      row.querySelector(".report-title").textContent = report.title;
      row.querySelector(".report-status").textContent = report.status === "parser_pending" ? "بانتظار التحليل" : report.status;
      row.querySelector(".report-summary").textContent = report.summary || "محفوظ في الذاكرة.";
      row.querySelector(".report-meta").textContent = `${report.source_type} · ${timeLabel(report.created_at)}${metrics ? ` · ${metrics}` : ""}`;
      reportList.append(row);
    }
  }

  documentsEl.innerHTML = "";
  if (!data.documents?.length) {
    documentsEl.innerHTML = `<div class="empty-row">ما فيه ملفات محفوظة حتى الآن.</div>`;
  } else {
    for (const doc of data.documents) {
      const row = document.createElement("div");
      row.className = "doc-row";
      row.innerHTML = `<div class="doc-title"></div><div class="doc-meta"></div>`;
      row.querySelector(".doc-title").textContent = doc.title || doc.id;
      row.querySelector(".doc-meta").textContent = `${doc.document_type || "file"} · ${timeLabel(doc.created_at)}`;
      documentsEl.append(row);
    }
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
  const userMessage = questionInput.value.trim();
  if (!userMessage) return;
  addMessage("user", userMessage);
  questionInput.value = "";
  const working = addMessage("system", "جاري تمرير السؤال على Health Committee...", "");
  try {
    const data = await api("/api/health/chat", {
      method: "POST",
      body: JSON.stringify({ user_message: userMessage, conversation_id: currentConversationId })
    });
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
    working.remove();
    addMessage("system", `تعذر تنفيذ الطلب: ${error.message}`);
  }
}

async function uploadCurrentFile() {
  if (!fileInput.files?.length) {
    uploadMessage.textContent = "اختر ملف أو أكثر أولاً.";
    return;
  }
  const files = Array.from(fileInput.files);
  const form = new FormData();
  if (currentConversationId) form.append("conversation_id", currentConversationId);
  for (const file of files) form.append("files", file);
  uploadMessage.textContent = `جاري حفظ ${files.length} ملف داخل HMDB...`;
  try {
    const data = await api("/api/documents", { method: "POST", body: form });
    const failed = data.results?.filter((item) => item.status === "failed").length || 0;
    const duplicates = data.results?.filter((item) => item.duplicate).length || 0;
    uploadMessage.textContent =
      failed > 0
        ? `تم حفظ ${data.saved || 0} ملف، وفشل ${failed}.`
        : duplicates > 0
          ? `تم الحفظ · ${duplicates} ملف محفوظ مسبقاً.`
          : `تم حفظ ${data.saved || files.length} ملف وتصنيفه مبدئياً.`;
    fileInput.value = "";
    await loadDashboard();
    setView("dashboard");
  } catch (error) {
    uploadMessage.textContent = error.message;
  }
}

function setView(view) {
  currentView = view;
  document.querySelectorAll(".view-pane").forEach((pane) => pane.classList.remove("active"));
  document.querySelector(`#${view}View`)?.classList.add("active");
  document.querySelectorAll(".rail-button").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  viewTitle.textContent = view === "dashboard" ? "الداشبورد" : view === "settings" ? "الإعدادات" : view === "admin" ? "الأدمن" : "المحادثة";
  pinCurrentButton.classList.toggle("hidden", view !== "chat");
  if (view === "dashboard") loadDashboard().catch(() => {});
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

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await uploadCurrentFile();
});

fileInput.addEventListener("change", () => {
  if (fileInput.files?.length && currentView === "chat") uploadCurrentFile();
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

if (new URLSearchParams(location.search).get("auth") === "pending") {
  loginMessage.textContent = "تم تسجيلك عبر Google، بانتظار موافقة الأدمن.";
}

await loadGoogleStatus();
await loadBootstrap();
