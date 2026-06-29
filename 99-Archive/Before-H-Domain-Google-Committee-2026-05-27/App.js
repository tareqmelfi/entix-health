const loginPanel = document.querySelector("#loginPanel");
const appPanel = document.querySelector("#appPanel");
const statusRow = document.querySelector("#statusRow");
const loginForm = document.querySelector("#loginForm");
const loginMessage = document.querySelector("#loginMessage");
const chatForm = document.querySelector("#chatForm");
const questionInput = document.querySelector("#question");
const messages = document.querySelector("#messages");
const uploadForm = document.querySelector("#uploadForm");
const fileInput = document.querySelector("#fileInput");
const uploadMessage = document.querySelector("#uploadMessage");
const documentsEl = document.querySelector("#documents");

function setStatus(kind, text) {
  const cls = kind === "ok" ? "ok" : kind === "bad" ? "bad" : "pending";
  statusRow.innerHTML = `<span class="status-dot ${cls}"></span><span>${text}</span>`;
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

function addMessage(type, text) {
  const item = document.createElement("div");
  item.className = `message ${type}`;
  item.textContent = text;
  messages.append(item);
  messages.scrollTop = messages.scrollHeight;
}

function showApp() {
  loginPanel.classList.add("hidden");
  appPanel.classList.remove("hidden");
}

async function loadDocuments() {
  const data = await api("/api/documents");
  documentsEl.innerHTML = "";
  if (!data.documents.length) {
    documentsEl.innerHTML = `<div class="doc-row"><div class="doc-title">No files yet</div><div class="doc-meta">Upload a lab PDF or text file to test storage.</div></div>`;
    return;
  }
  for (const doc of data.documents) {
    const row = document.createElement("div");
    row.className = "doc-row";
    const date = new Date(doc.created_at).toLocaleString();
    row.innerHTML = `<div class="doc-title"></div><div class="doc-meta"></div>`;
    row.querySelector(".doc-title").textContent = doc.title || doc.id;
    row.querySelector(".doc-meta").textContent = `${doc.document_type || "file"} · ${date}`;
    documentsEl.append(row);
  }
}

async function loadBootstrap() {
  try {
    const data = await api("/api/bootstrap");
    showApp();
    setStatus(data.hmdb_ready ? "ok" : "pending", data.hmdb_ready ? "DB + n8n connected" : "partial setup");
    if (!messages.children.length) {
      addMessage("system", "T-OS Health is online. General chat and private file storage are ready for testing.");
    }
    await loadDocuments();
  } catch {
    setStatus("pending", "locked");
  }
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
  const question = questionInput.value.trim();
  if (!question) return;
  addMessage("user", question);
  questionInput.value = "";
  addMessage("system", "Working through n8n...");
  try {
    const data = await api("/api/chat", { method: "POST", body: JSON.stringify({ question }) });
    messages.lastElementChild?.remove();
    addMessage("system", data.answer || "No answer returned.");
  } catch (error) {
    messages.lastElementChild?.remove();
    addMessage("system", `Error: ${error.message}`);
  }
});

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!fileInput.files?.length) {
    uploadMessage.textContent = "Choose a file first.";
    return;
  }
  const form = new FormData();
  form.append("file", fileInput.files[0]);
  uploadMessage.textContent = "Uploading to private HMDB storage...";
  try {
    const data = await api("/api/documents", { method: "POST", body: form });
    uploadMessage.textContent = data.duplicate ? "Already stored. Duplicate skipped." : `Stored. n8n: ${data.n8n?.status || "accepted"}`;
    fileInput.value = "";
    await loadDocuments();
  } catch (error) {
    uploadMessage.textContent = error.message;
  }
});

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
  });
});

await loadBootstrap();
