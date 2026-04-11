// ── State ────────────────────────────────────────────────────────────────────
let id = null;
let connected = false;
let typingHideTimeout = null;

// ── File transfer state ───────────────────────────────────────────────────────
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB
const CHUNK_SIZE    = 32 * 1024;        // 32 KB per chunk
// transferId → { name, size, mime, from, chunks: [], received, total }
const incomingTransfers = new Map();
// transferId → { file, to }
const outgoingTransfers = new Map();

// contacts: code → { nickname, keyPair, sharedKey, unread, saved }
// saved=true  → persisted in localStorage
// saved=false → temporary (unknown contact that initiated contact with us)
const contacts = new Map();

// messages: code → [{ from, text, timestamp }]  (ephemeral, lost on close)
const messages = new Map();

let activeContact = null;


// ── Contacts persistence ──────────────────────────────────────────────────────
function loadContacts() {
  const saved = JSON.parse(localStorage.getItem("ghostchat_contacts") || "[]");
  for (const { code, nickname } of saved) {
    contacts.set(code, { nickname, keyPair: null, sharedKey: null, unread: 0, saved: true });
    messages.set(code, []);
  }
  renderContactList();
}

function saveContacts() {
  const arr = [];
  for (const [code, c] of contacts) {
    if (c.saved) arr.push({ code, nickname: c.nickname });
  }
  localStorage.setItem("ghostchat_contacts", JSON.stringify(arr));
}

function addContact(code, nickname) {
  if (contacts.has(code)) {
    // If it existed as temporary, just mark it as saved
    const c = contacts.get(code);
    c.nickname = nickname || c.nickname;
    c.saved = true;
  } else {
    contacts.set(code, { nickname: nickname || code.slice(0, 8) + "…", keyPair: null, sharedKey: null, unread: 0, saved: true });
    messages.set(code, []);
  }
  saveContacts();
  renderContactList();
}

function removeContact(code) {
  contacts.delete(code);
  messages.delete(code);
  if (activeContact === code) {
    activeContact = null;
    showPlaceholder();
  }
  saveContacts();
  renderContactList();
}


// ── Contact list UI ───────────────────────────────────────────────────────────
function renderContactList() {
  const list = document.getElementById("contact-list");
  list.innerHTML = "";

  for (const [code, c] of contacts) {
    const li = document.createElement("li");
    li.className = "contact-item" + (code === activeContact ? " active" : "") + (!c.saved ? " unsaved" : "");
    li.dataset.code = code;

    const name = document.createElement("span");
    name.className = "contact-name";
    name.textContent = c.nickname;

    const actions = document.createElement("div");
    actions.className = "contact-actions";

    if (!c.saved) {
      const saveBtn = document.createElement("button");
      saveBtn.className = "contact-save";
      saveBtn.textContent = "Save";
      saveBtn.title = "Add to contacts";
      saveBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        c.saved = true;
        saveContacts();
        renderContactList();
      });
      actions.appendChild(saveBtn);
    }

    const delBtn = document.createElement("button");
    delBtn.className = "contact-delete";
    delBtn.textContent = "×";
    delBtn.title = "Remove contact";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeContact(code);
    });
    actions.appendChild(delBtn);

    li.appendChild(name);

    if (c.unread > 0) {
      const badge = document.createElement("span");
      badge.className = "unread-badge";
      badge.textContent = c.unread;
      li.appendChild(badge);
    }

    li.appendChild(actions);
    li.addEventListener("click", () => openConversation(code));
    list.appendChild(li);
  }
}

// ── Conversation ──────────────────────────────────────────────────────────────
async function openConversation(code) {
  activeContact = code;
  const contact = contacts.get(code);
  contact.unread = 0;
  renderContactList();

  // Show chat UI
  document.getElementById("chat-placeholder").hidden = true;
  document.getElementById("messages").hidden = false;
  document.getElementById("message-form").hidden = false;
  document.getElementById("app").classList.add("chat-active");
  document.getElementById("chat-contact-name").textContent = contact.nickname;
  clearTyping();

  // Reset file preview and progress
  document.getElementById("file-send").value = "";
  document.getElementById("file-preview-img").hidden = true;
  document.getElementById("file-preview-img").src = "";
  document.getElementById("file-preview-name").textContent = "";
  document.getElementById("file-preview").hidden = true;
  hideProgress();

  // Render stored messages
  const msgEl = document.getElementById("messages");
  msgEl.innerHTML = "";
  for (const msg of messages.get(code) || []) {
    appendMessageElement(msg.from, msg.text);
  }

  // Initiate key exchange if no shared key yet
  if (!contact.sharedKey) {
    contact.keyPair = await GhostCrypto.generateKeyPair();
    const pub = await GhostCrypto.exportPublicKey(contact.keyPair.publicKey);
    WS.send({ type: "key_exchange", to: code, payload: pub });
  }
}

function showPlaceholder() {
  document.getElementById("chat-placeholder").hidden = false;
  document.getElementById("messages").hidden = true;
  document.getElementById("message-form").hidden = true;
  document.getElementById("app").classList.remove("chat-active");
  clearTyping();
}


// ── WebSocket message handler ─────────────────────────────────────────────────
async function handleMessage(data) {
  switch (data.type) {

    case "registered":
      id = data.id;
      localStorage.setItem("ghostchat_id", id);
      document.getElementById("my-id").textContent = id;
      document.getElementById("status").textContent = "Connected";
      connected = true;
      break;

    case "logged_in":
      id = data.id;
      localStorage.setItem("ghostchat_id", id);
      document.getElementById("my-id").textContent = id;
      document.getElementById("status").textContent = "Connected";
      connected = true;
      break;

    case "id_refreshed":
      id = data.id;
      localStorage.setItem("ghostchat_id", id);
      document.getElementById("my-id").textContent = id;
      break;

    case "key_exchange": {
      const from = data.from;

      // If unknown, add as temporary contact so the conversation can happen
      if (!contacts.has(from)) {
        contacts.set(from, { nickname: from.slice(0, 8) + "…", keyPair: null, sharedKey: null, unread: 0, saved: false });
        messages.set(from, []);
        renderContactList();
      }

      const contact = contacts.get(from);

      // Respond with our public key if we haven't sent one yet
      if (!contact.keyPair) {
        contact.keyPair = await GhostCrypto.generateKeyPair();
        const pub = await GhostCrypto.exportPublicKey(contact.keyPair.publicKey);
        WS.send({ type: "key_exchange", to: from, payload: pub });
      }

      const peerPublicKey = await GhostCrypto.importPublicKey(data.payload);
      contact.sharedKey = await GhostCrypto.deriveSharedKey(contact.keyPair.privateKey, peerPublicKey);

      if (activeContact === from) appendStatus("E2E encryption activated");
      break;
    }

    case "sended": {
      const from = data.from;
      const contact = contacts.get(from);
      if (!contact || !contact.sharedKey) break;

      const text = await GhostCrypto.decrypt(contact.sharedKey, data.nonce, data.payload);
      messages.get(from).push({ from, text, timestamp: data.timestamp });

      if (activeContact === from) {
        clearTyping();
        appendMessageElement(from, text);
      } else {
        contact.unread++;
        renderContactList();
      }
      break;
    }

    case "file_meta": {
      const contact = contacts.get(data.from);
      if (!contact?.sharedKey) break;
      const metaStr = await GhostCrypto.decrypt(contact.sharedKey, data.nonce, data.payload);
      const meta = JSON.parse(metaStr);
      incomingTransfers.set(data.transferId, {
        name: meta.name, size: meta.size, mime: meta.mime,
        from: data.from, chunks: [], received: 0, total: null,
      });
      const senderName = contact.nickname ?? data.from.slice(0, 8) + "…";
      document.getElementById("file-incoming-sender").textContent = `From: ${senderName}`;
      document.getElementById("file-incoming-info").textContent =
        `${meta.name}  (${formatFileSize(meta.size)})`;
      const modal = document.getElementById("file-incoming-modal");
      modal.dataset.transferId = data.transferId;
      modal.dataset.from = data.from;
      modal.hidden = false;
      break;
    }

    case "file_chunk": {
      const transfer = incomingTransfers.get(data.transferId);
      if (!transfer) break;
      const contact = contacts.get(data.from);
      if (!contact?.sharedKey) break;
      if (transfer.total === null) transfer.total = data.total;
      const chunkBytes = await GhostCrypto.decryptBytes(contact.sharedKey, data.nonce, data.payload);
      transfer.chunks[data.index] = chunkBytes;
      transfer.received++;
      showProgress(`Receiving ${transfer.name}`, (transfer.received / transfer.total) * 100);
      if (transfer.received === transfer.total) {
        triggerDownload(transfer.chunks, transfer.name, transfer.mime);
        appendStatus(`File "${transfer.name}" received`);
        hideProgress();
        incomingTransfers.delete(data.transferId);
      }
      break;
    }

    case "file_accept":
      startChunkedSend(data.transferId);
      break;

    case "file_reject": {
      const transfer = outgoingTransfers.get(data.transferId);
      if (transfer) {
        appendStatus("File transfer rejected");
        outgoingTransfers.delete(data.transferId);
        hideProgress();
      }
      break;
    }

    case "typing":
      if (data.from === activeContact) showTyping(data.from);
      break;

    case "delivery_status":
      if (activeContact) appendStatus(data.delivered ? "Delivered" : "Not delivered");
      break;

    case "error":
      if (activeContact) appendStatus(`Error: ${data.message}`);
      break;
  }
}


// ── DOM setup ─────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  if (localStorage.getItem("ghostchat_theme") === "light") {
    document.body.classList.add("light");
  }

  loadContacts();

  WS.onOpen(() => {
    WS.onMessage(handleMessage);
    const saved = localStorage.getItem("ghostchat_id");
    if (saved) {
      WS.login(saved);
    } else {
      WS.register();
    }
  });

  WS.onDisconnect(() => {
    document.getElementById("status").textContent = "Reconnecting...";
    connected = false;
    for (const c of contacts.values()) {
      c.sharedKey = null;
      c.keyPair = null;
    }
  });

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  WS.connect(`${protocol}//${window.location.host}/ws`);

  // Send message or file
  document.getElementById("message-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!activeContact) return;
    const contact = contacts.get(activeContact);
    if (!contact?.sharedKey) return;

    // File takes priority when selected
    const fileInput = document.getElementById("file-send");
    if (fileInput.files[0]) {
      const file = fileInput.files[0];
      if (file.size > MAX_FILE_SIZE) {
        appendStatus(`File too large (max ${formatFileSize(MAX_FILE_SIZE)})`);
        return;
      }
      const transferId = generateTransferId();
      outgoingTransfers.set(transferId, { file, to: activeContact });
      const meta = JSON.stringify({ name: file.name, size: file.size, mime: file.type });
      const enc = await GhostCrypto.encrypt(contact.sharedKey, meta);
      WS.send({ type: "file_meta", to: activeContact, transferId, payload: enc.ciphertext, nonce: enc.nonce });
      showProgress("Waiting for acceptance…", 0);
      // Clear file preview
      fileInput.value = "";
      document.getElementById("file-preview-img").hidden = true;
      document.getElementById("file-preview-img").src = "";
      document.getElementById("file-preview-name").textContent = "";
      document.getElementById("file-preview").hidden = true;
      return;
    }

    const input = document.getElementById("message-input");
    const text = input.value.trim();
    if (!text) return;

    const encrypted = await GhostCrypto.encrypt(contact.sharedKey, text);
    WS.send({ type: "text", to: activeContact, payload: encrypted.ciphertext, nonce: encrypted.nonce, timestamp: Date.now() });
    messages.get(activeContact).push({ from: "You", text, timestamp: Date.now() });
    appendMessageElement("You", text);
    input.value = "";
  });

  // File incoming: accept
  document.getElementById("file-incoming-accept").addEventListener("click", () => {
    const modal = document.getElementById("file-incoming-modal");
    const transferId = modal.dataset.transferId;
    const from = modal.dataset.from;
    modal.hidden = true;
    WS.send({ type: "file_accept", to: from, transferId });
    const transfer = incomingTransfers.get(transferId);
    if (transfer) showProgress(`Receiving ${transfer.name}`, 0);
  });

  // File incoming: reject
  document.getElementById("file-incoming-reject").addEventListener("click", () => {
    const modal = document.getElementById("file-incoming-modal");
    const transferId = modal.dataset.transferId;
    const from = modal.dataset.from;
    modal.hidden = true;
    WS.send({ type: "file_reject", to: from, transferId });
    incomingTransfers.delete(transferId);
  });

  // Typing indicator (debounced)
  let typingSent = false;
  let typingCooldown = null;
  document.getElementById("message-input").addEventListener("input", () => {
    if (!activeContact || !contacts.get(activeContact)?.sharedKey) return;
    if (!typingSent) {
      WS.sendTyping(activeContact);
      typingSent = true;
    }
    clearTimeout(typingCooldown);
    typingCooldown = setTimeout(() => { typingSent = false; }, 2000);
  });

  // Copy ID — with context message so the recipient understands what it is
  document.getElementById("btn-copy").addEventListener("click", () => {
    if (id) navigator.clipboard.writeText(`Mi id de Ghostchat Messenger es: ${id}`);
  });

  // QR code
  document.getElementById("btn-qr").addEventListener("click", () => {
    if (!id) return;
    const canvas = document.getElementById("qr-canvas");
    canvas.innerHTML = "";
    new QRCode(canvas, { text: id, width: 200, height: 200 });
    document.getElementById("qr-modal").hidden = false;
  });

  document.getElementById("qr-close").addEventListener("click", () => {
    document.getElementById("qr-modal").hidden = true;
  });
  document.getElementById("qr-backdrop").addEventListener("click", () => {
    document.getElementById("qr-modal").hidden = true;
  });

  // Refresh ID
  document.getElementById("btn-refresh").addEventListener("click", () => {
    WS.refreshId();
  });

  // Theme toggle
  document.getElementById("btn-theme").addEventListener("click", () => {
    document.body.classList.toggle("light");
    localStorage.setItem("ghostchat_theme", document.body.classList.contains("light") ? "light" : "dark");
  });

  // Add contact modal
  document.getElementById("btn-add-contact").addEventListener("click", () => {
    document.getElementById("add-contact-code").value = "";
    document.getElementById("add-contact-nickname").value = "";
    document.getElementById("add-contact-modal").hidden = false;
    document.getElementById("add-contact-code").focus();
  });

  document.getElementById("add-contact-cancel").addEventListener("click", () => {
    document.getElementById("add-contact-modal").hidden = true;
  });
  document.getElementById("add-contact-backdrop").addEventListener("click", () => {
    document.getElementById("add-contact-modal").hidden = true;
  });

  document.getElementById("add-contact-confirm").addEventListener("click", () => {
    const code = document.getElementById("add-contact-code").value.trim();
    const nickname = document.getElementById("add-contact-nickname").value.trim();
    if (!code) return;
    addContact(code, nickname || code.slice(0, 8) + "…");
    document.getElementById("add-contact-modal").hidden = true;
  });

  // Allow submitting add-contact with Enter
  document.getElementById("add-contact-nickname").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("add-contact-confirm").click();
  });

  // File preview
  const fileInput = document.getElementById("file-send");
  const filePreview = document.getElementById("file-preview");
  const filePreviewImg = document.getElementById("file-preview-img");
  const filePreviewName = document.getElementById("file-preview-name");
  const filePreviewClear = document.getElementById("file-preview-clear");

  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (!file) return;

    filePreviewName.textContent = `${file.name} (${formatFileSize(file.size)})`;

    if (file.type.startsWith("image/")) {
      const reader = new FileReader();
      reader.onload = (e) => {
        filePreviewImg.src = e.target.result;
        filePreviewImg.hidden = false;
      };
      reader.readAsDataURL(file);
    } else {
      filePreviewImg.hidden = true;
    }

    filePreview.hidden = false;
  });

  filePreviewClear.addEventListener("click", () => {
    fileInput.value = "";
    filePreviewImg.hidden = true;
    filePreviewImg.src = "";
    filePreviewName.textContent = "";
    filePreview.hidden = true;
  });

  // Back button (mobile)
  document.getElementById("btn-back").addEventListener("click", () => {
    activeContact = null;
    showPlaceholder();
    renderContactList();
  });
});


// ── UI helpers ────────────────────────────────────────────────────────────────
function showTyping(from) {
  document.getElementById("typing-indicator").textContent = `${contacts.get(from)?.nickname ?? from.slice(0, 8)} is typing…`;
  clearTimeout(typingHideTimeout);
  typingHideTimeout = setTimeout(clearTyping, 3000);
}

function clearTyping() {
  document.getElementById("typing-indicator").textContent = "";
}

function appendMessageElement(from, text) {
  const msgs = document.getElementById("messages");
  const div = document.createElement("div");
  const isSelf = from === "You";
  div.className = isSelf ? "msg msg-sent" : "msg msg-received";
  const label = isSelf ? "You" : (contacts.get(from)?.nickname ?? from.slice(0, 8) + "…");
  div.textContent = `${label}: ${text}`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function appendStatus(text) {
  const msgs = document.getElementById("messages");
  const div = document.createElement("div");
  div.textContent = text;
  div.className = "msg msg-system";
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}


// ── File transfer helpers ─────────────────────────────────────────────────────
function generateTransferId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map(b => b.toString(16).padStart(2, "0")).join("");
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function showProgress(label, pct) {
  document.getElementById("file-progress").hidden = false;
  document.getElementById("file-progress-label").textContent = label;
  document.getElementById("file-progress-fill").style.width = `${pct}%`;
  document.getElementById("file-progress-pct").textContent = `${Math.round(pct)}%`;
}

function hideProgress() {
  document.getElementById("file-progress").hidden = true;
  document.getElementById("file-progress-fill").style.width = "0%";
}

async function startChunkedSend(transferId) {
  const transfer = outgoingTransfers.get(transferId);
  if (!transfer) return;
  const { file, to } = transfer;
  const contact = contacts.get(to);
  if (!contact?.sharedKey) return;

  const total = Math.ceil(file.size / CHUNK_SIZE);
  const buffer = await file.arrayBuffer();

  for (let i = 0; i < total; i++) {
    const start = i * CHUNK_SIZE;
    const slice = new Uint8Array(buffer, start, Math.min(CHUNK_SIZE, file.size - start));
    const enc = await GhostCrypto.encryptBytes(contact.sharedKey, slice);
    WS.send({ type: "file_chunk", to, transferId, index: i, total, payload: enc.ciphertext, nonce: enc.nonce });
    showProgress(`Sending ${file.name}`, ((i + 1) / total) * 100);
    // Yield to keep UI responsive between chunks
    await new Promise(r => setTimeout(r, 0));
  }

  appendStatus(`File "${file.name}" sent`);
  hideProgress();
  outgoingTransfers.delete(transferId);
}

function triggerDownload(chunks, name, mime) {
  const blob = new Blob(chunks, { type: mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
