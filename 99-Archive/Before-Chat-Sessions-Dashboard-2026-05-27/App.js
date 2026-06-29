const loginPanel = document.querySelector("#loginPanel");
const appPanel = document.querySelector("#appPanel");
const statusText = document.querySelector("#statusText");
const statusPill = document.querySelector("#statusPill");
const loginForm = document.querySelector("#loginForm");
const loginMessage = document.querySelector("#loginMessage");
const googleLogin = document.querySelector("#googleLogin");
const oauthNote = document.querySelector("#oauthNote");
const chatForm = document.querySelector("#chatForm");
const mobileChatForm = document.querySelector("#mobileChatForm");
const questionInput = document.querySelector("#question");
const mobileQuestionInput = document.querySelector("#mobileQuestion");
const messages = document.querySelector("#messages");
const uploadForm = document.querySelector("#uploadForm");
const fileInput = document.querySelector("#fileInput");
const uploadMessage = document.querySelector("#uploadMessage");
const documentsEl = document.querySelector("#documents");
const adminPanel = document.querySelector("#adminPanel");
const addUserForm = document.querySelector("#addUserForm");
const usersList = document.querySelector("#usersList");
const debugPanel = document.querySelector("#debugPanel");
const debugBox = document.querySelector("#debugBox");
const profileName = document.querySelector("#profileName");
const profileSub = document.querySelector("#profileSub");

let bootstrap = null;
let debugEnabled = false;

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

function setDebug(payload) {
  debugBox.textContent = JSON.stringify(payload, null, 2);
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

function showApp() {
  loginPanel.classList.add("hidden");
  appPanel.classList.remove("hidden");
  mobileChatForm.classList.remove("hidden");
}

async function loadGoogleStatus() {
  const status = await api("/api/auth/google/status").catch(() => ({ enabled: false }));
  if (status.enabled) {
    googleLogin.classList.remove("disabled");
    oauthNote.textContent = "Google Login مفعّل لهذا الدومين.";
  } else {
    googleLogin.classList.add("disabled");
    googleLogin.addEventListener("click", (event) => event.preventDefault(), { once: true });
    oauthNote.textContent = "Google Login جاهز بالكود، وينتظر Google OAuth Client ID/Secret للدومين h.fc.sa.";
  }
}

async function loadDocuments() {
  const data = await api("/api/documents");
  documentsEl.innerHTML = "";
  if (!data.documents.length) {
    documentsEl.innerHTML = `<div class="empty-row">ما فيه ملفات محفوظة حتى الآن.</div>`;
    return;
  }
  for (const doc of data.documents) {
    const row = document.createElement("div");
    row.className = "doc-row";
    const date = new Date(doc.created_at).toLocaleDateString("ar-SA");
    row.innerHTML = `<div class="doc-title"></div><div class="doc-meta"></div>`;
    row.querySelector(".doc-title").textContent = doc.title || doc.id;
    row.querySelector(".doc-meta").textContent = `${doc.document_type || "file"} · ${date}`;
    documentsEl.append(row);
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
    setStatus(bootstrap.hmdb_ready && bootstrap.n8n_health_committee ? "ok" : "pending", bootstrap.n8n_health_committee ? "Health Committee + HMDB متصلين" : "HMDB متصل · committee قيد التجهيز");
    if (!messages.children.length) {
      addMessage("system", "مرحباً. المسار الآن يمر عبر Health Committee ثم HMDB. اسأل سؤال عام أو ارفع ملف للتخزين.", "الآن");
    }
    await Promise.all([loadDocuments(), loadUsers()]);
  } catch {
    setStatus("pending", "سجل الدخول للمتابعة");
  }
}

async function submitChat(source) {
  const input = source === "mobile" ? mobileQuestionInput : questionInput;
  const userMessage = input.value.trim();
  if (!userMessage) return;
  addMessage("user", userMessage);
  input.value = "";
  if (source === "mobile") questionInput.value = "";
  else mobileQuestionInput.value = "";
  const working = addMessage("system", "جاري تمرير السؤال على Health Committee...", "");
  try {
    const data = await api("/api/health/chat", {
      method: "POST",
      body: JSON.stringify({ user_message: userMessage })
    });
    working.remove();
    const meta = data.validator_status?.status ? `validator: ${data.validator_status.status}` : "";
    addMessage("system", data.answer || "ما رجع رد.", meta);
    setDebug({
      request_id: data.request_id,
      validator_status: data.validator_status,
      models_used: data.models_used,
      n8n: data.n8n
    });
  } catch (error) {
    working.remove();
    addMessage("system", `تعذر تنفيذ الطلب: ${error.message}`);
  }
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
  await submitChat("desktop");
});

mobileChatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await submitChat("mobile");
});

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!fileInput.files?.length) {
    uploadMessage.textContent = "اختر ملف أولاً.";
    return;
  }
  const form = new FormData();
  form.append("file", fileInput.files[0]);
  uploadMessage.textContent = "جاري الحفظ داخل HMDB...";
  try {
    const data = await api("/api/documents", { method: "POST", body: form });
    uploadMessage.textContent = data.duplicate ? "الملف محفوظ مسبقاً." : `تم الحفظ · ${data.n8n?.status || "accepted"}`;
    fileInput.value = "";
    await loadDocuments();
  } catch (error) {
    uploadMessage.textContent = error.message;
  }
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

document.querySelector("#mobileDebugToggle").addEventListener("click", () => {
  debugEnabled = !debugEnabled;
  debugPanel.classList.toggle("hidden", !debugEnabled);
});

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    if (button.dataset.view === "admin") adminPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  });
});

document.querySelector("#composerAttach").addEventListener("click", () => fileInput.click());
document.querySelector("#mobileAttach").addEventListener("click", () => fileInput.click());
document.querySelector("#newConsultation").addEventListener("click", () => {
  messages.innerHTML = "";
  addMessage("system", "بدأت استشارة جديدة. اكتب سؤالك أو ارفع ملف.", "الآن");
});

if (new URLSearchParams(location.search).get("auth") === "pending") {
  loginMessage.textContent = "تم تسجيلك عبر Google، بانتظار موافقة الأدمن.";
}

await loadGoogleStatus();
await loadBootstrap();
