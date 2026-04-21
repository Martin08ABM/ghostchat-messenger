// ── Security & Validation Helpers ─────────────────────────────────────────────

/**
 * Sanitiza el input para prevenir XSS
 * @param {string} str - String a sanitizar
 * @returns {string} String sanitizado
 */
function sanitizeInput(str) {
  if (typeof str !== 'string') return '';
  
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Valida un código de usuario (ID)
 * @param {string} code - Código a validar
 * @returns {boolean} true si es válido
 */
function isValidUserCode(code) {
  if (!code || typeof code !== 'string') return false;
  return /^[a-zA-Z0-9]{8,32}$/.test(code);
}

/**
 * Valida un nickname
 * @param {string} nickname - Nickname a validar
 * @returns {boolean} true si es válido
 */
function isValidNickname(nickname) {
  if (!nickname || typeof nickname !== 'string') return false;
  return nickname.length <= 50 && nickname.trim().length > 0;
}

/**
 * Valida y limita el tamaño de mensaje
 * @param {string} text - Texto a validar
 * @returns {object} {valid: boolean, error?: string}
 */
function validateMessageText(text) {
  if (!text || typeof text !== 'string') {
    return { valid: false, error: 'Message cannot be empty' };
  }
  
  const MAX_MESSAGE_LENGTH = 10000; // 10KB max
  
  if (text.length > MAX_MESSAGE_LENGTH) {
    return { valid: false, error: `Message too long (max ${MAX_MESSAGE_LENGTH} chars)` };
  }
  
  // Verificar contenido peligroso (solo advertencia)
  const dangerousPatterns = [
    /<script/i,
    /javascript:/i,
    /on\w+\s*=/i  // onerror, onclick, etc.
  ];
  
  const hasDangerousContent = dangerousPatterns.some(pattern => pattern.test(text));
  if (hasDangerousContent) {
    console.warn('[Security] Potentially dangerous content detected in message');
  }
  
  return { valid: true };
}

/**
 * Escapa atributos HTML para usar en templates
 * @param {string} str - String a escapar
 * @returns {string} String escapado
 */
function escapeHtmlAttribute(str) {
  return str.replace(/["&<>]/g, (char) => {
    switch (char) {
      case '"': return '&quot;';
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      default: return char;
    }
  });
}

// ── State ────────────────────────────────────────────────────────────────────
let id = null;
let connected = false;
let typingHideTimeout = null;

// ── File transfer state ───────────────────────────────────────────────────────
const MAX_FILE_SIZE       = 25 * 1024 * 1024; // 25 MB
const CHUNK_SIZE          = 32 * 1024;        // 32 KB per chunk
const TRANSFER_TIMEOUT_MS = 90_000;           // 90 s — stalled transfer cleanup
// transferId → { name, size, mime, from, chunks: [], received, total, timeoutId }
const incomingTransfers = new Map();
// transferId → { file, to, timeoutId }
const outgoingTransfers = new Map();
// Queue of pending incoming file offers { transferId, from, meta } not yet shown in modal
const incomingFileQueue = [];

// contacts: code → { nickname, keyPair, sharedKey, unread, saved }
// saved=true  → persisted in localStorage
// saved=false → temporary contact (initiated contact with us, not yet saved)
const contacts = new Map();

// messages: code → [{ from, text, timestamp }]  (ephemeral, lost on close)
const messages = new Map();

let activeContact = null;


// ── Contacts persistence ──────────────────────────────────────────────────────
function loadContacts() {
  try {
    const saved = JSON.parse(localStorage.getItem("ghostchat_contacts") || "[]");
    for (const { code, nickname } of saved) {
      if (isValidUserCode(code) && isValidNickname(nickname)) {
        contacts.set(code, { 
          nickname: sanitizeInput(nickname), 
          keyPair: null, 
          sharedKey: null, 
          unread: 0, 
          saved: true 
        });
        messages.set(code, []);
      }
    }
    renderContactList();
  } catch (error) {
    console.error('[Security] Error loading contacts:', error);
    localStorage.removeItem("ghostchat_contacts");
  }
}

function saveContacts() {
  try {
    const arr = [];
    for (const [code, c] of contacts) {
      if (c.saved && isValidUserCode(code) && isValidNickname(c.nickname)) {
        arr.push({ 
          code, 
          nickname: c.nickname.substring(0, 50) 
        });
      }
    }
    localStorage.setItem("ghostchat_contacts", JSON.stringify(arr));
  } catch (error) {
    console.error('[Security] Error saving contacts:', error);
  }
}

function addContact(code, nickname) {
  // Validar inputs
  if (!isValidUserCode(code)) {
    console.error('[Security] Invalid contact code format:', code);
    appendStatus("Error: Invalid contact code format");
    return;
  }
  
  if (!isValidNickname(nickname)) {
    console.error('[Security] Invalid nickname:', nickname);
    appendStatus("Error: Invalid nickname");
    return;
  }
  
  const sanitizedNickname = sanitizeInput(nickname);
  
  if (contacts.has(code)) {
    const c = contacts.get(code);
    c.nickname = sanitizedNickname || c.nickname;
    c.saved = true;
  } else {
    contacts.set(code, { 
      nickname: sanitizedNickname, 
      keyPair: null, 
      sharedKey: null, 
      unread: 0, 
      saved: true 
    });
    messages.set(code, []);
  }
  saveContacts();
  renderContactList();
}

function removeContact(code) {
  if (!isValidUserCode(code)) {
    console.error('[Security] Invalid code when removing contact:', code);
    return;
  }
  
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
    // Validar código antes de renderizar
    if (!isValidUserCode(code)) {
      console.warn('[Security] Skipping invalid contact code:', code);
      continue;
    }
    
    const li = document.createElement("li");
    li.className = "contact-item" + (code === activeContact ? " active" : "") + (!c.saved ? " unsaved" : "");
    li.dataset.code = escapeHtmlAttribute(code);

    const name = document.createElement("span");
    name.className = "contact-name";
    name.textContent = c.nickname || code.slice(0, 8) + "…";

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
      if (confirm(`Are you sure you want to remove ${c.nickname}?`)) {
        removeContact(code);
      }
    });
    actions.appendChild(delBtn);

    li.appendChild(name);

    if (c.unread > 0) {
      // Limitar el número de notificaciones no leídas mostradas
      const unreadCount = Math.min(c.unread, 99);
      const badge = document.createElement("span");
      badge.className = "unread-badge";
      badge.textContent = unreadCount;
      badge.setAttribute("aria-label", `${unreadCount} unread messages`);
      li.appendChild(badge);
    }

    li.appendChild(actions);
    li.addEventListener("click", () => openConversation(code));
    list.appendChild(li);
  }
}

// ── Conversation ──────────────────────────────────────────────────────────────
async function openConversation(code) {
  if (!isValidUserCode(code)) {
    console.error('[Security] Invalid code when opening conversation:', code);
    return;
  }
  
  activeContact = code;
  const contact = contacts.get(code);
  contact.unread = 0;
  renderContactList();

  document.getElementById("chat-placeholder").hidden = true;
  document.getElementById("messages").hidden = false;
  document.getElementById("message-form").hidden = false;
  document.getElementById("app").classList.add("chat-active");
  document.getElementById("chat-contact-name").textContent = contact.nickname;
  clearTyping();

  document.getElementById("file-send").value = "";
  document.getElementById("file-preview-img").hidden = true;
  document.getElementById("file-preview-img").src = "";
  document.getElementById("file-preview-name").textContent = "";
  document.getElementById("file-preview").hidden = true;
  hideProgress();

  const msgEl = document.getElementById("messages");
  msgEl.innerHTML = "";
  for (const msg of messages.get(code) || []) {
    appendMessageElement(msg.from, msg.text);
  }

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
  // Validar tipo de mensaje recibido
  if (!data || !data.type) {
    console.warn('[Security] Invalid message received:', data);
    return;
  }
  
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
      
      if (!isValidUserCode(from)) {
        console.error('[Security] Invalid code in key_exchange:', from);
        break;
      }

      if (!contacts.has(from)) {
        contacts.set(from, { nickname: from.slice(0, 8) + "…", keyPair: null, sharedKey: null, unread: 0, saved: false });
        messages.set(from, []);
        renderContactList();
      }

      const contact = contacts.get(from);

      if (!contact.keyPair) {
        contact.keyPair = await GhostCrypto.generateKeyPair();
        const pub = await GhostCrypto.exportPublicKey(contact.keyPair.publicKey);
        WS.send({ type: "key_exchange", to: from, payload: pub });
      }

      const peerPublicKey = await GhostCrypto.importPublicKey(data.payload);
      const { key, fingerprint } = await GhostCrypto.deriveSharedKey(contact.keyPair.privateKey, contact.keyPair.publicKey, peerPublicKey);
      contact.sharedKey = key;

      if (activeContact === from) appendStatus(`E2E encryption activated · Fingerprint: ${sanitizeInput(fingerprint)}`);
      break;
    }

    case "sended": {
      const from = data.from;
      
      if (!isValidUserCode(from)) {
        console.error('[Security] Invalid code in sended:', from);
        break;
      }
      
      const contact = contacts.get(from);
      if (!contact || !contact.sharedKey) break;

      const text = await GhostCrypto.decrypt(contact.sharedKey, data.nonce, data.payload);
      
      // Validar mensaje desencriptado
      const validation = validateMessageText(text);
      if (!validation.valid) {
        console.warn('[Security] Invalid message text received:', validation.error);
        break;
      }
      
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
      const timeoutId = setTimeout(() => {
        if (incomingTransfers.has(data.transferId)) {
          incomingTransfers.delete(data.transferId);
          appendStatus(`Incoming file "${sanitizeInput(meta.name)}" timed out`);
          hideProgress();
        }
        const qi = incomingFileQueue.findIndex(e => e.transferId === data.transferId);
        if (qi !== -1) incomingFileQueue.splice(qi, 1);
      }, TRANSFER_TIMEOUT_MS);
      incomingTransfers.set(data.transferId, {
        name: sanitizeInput(meta.name), size: meta.size, mime: sanitizeInput(meta.mime),
        from: data.from, chunks: [], received: 0, total: null, timeoutId,
      });
      const modal = document.getElementById("file-incoming-modal");
      if (!modal.hidden) {
        incomingFileQueue.push({ transferId: data.transferId, from: data.from, meta });
      } else {
        _showIncomingFileModal(data.transferId, data.from, meta, contact);
      }
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
      showProgress(`Receiving ${sanitizeInput(transfer.name)}`, (transfer.received / transfer.total) * 100);
      if (transfer.received === transfer.total) {
        clearTimeout(transfer.timeoutId);
        triggerDownload(transfer.chunks, transfer.name, transfer.mime);
        appendStatus(`File "${sanitizeInput(transfer.name)}" received`);
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
        clearTimeout(transfer.timeoutId);
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
      if (activeContact) appendStatus(`Error: ${sanitizeInput(data.message)}`);
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

  document.getElementById("message-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!activeContact) return;
    const contact = contacts.get(activeContact);
    if (!contact?.sharedKey) return;

    const fileInput = document.getElementById("file-send");
    if (fileInput.files[0]) {
      const file = fileInput.files[0];
      if (file.size > MAX_FILE_SIZE) {
        appendStatus(`File too large (max ${formatFileSize(MAX_FILE_SIZE)})`);
        return;
      }
      const transferId = generateTransferId();
      const outTimeoutId = setTimeout(() => {
        if (outgoingTransfers.has(transferId)) {
          outgoingTransfers.delete(transferId);
          appendStatus(`File "${sanitizeInput(file.name)}" transfer timed out`);
          hideProgress();
        }
      }, TRANSFER_TIMEOUT_MS);
      outgoingTransfers.set(transferId, { file, to: activeContact, timeoutId: outTimeoutId });
      const meta = JSON.stringify({ name: file.name, size: file.size, mime: file.type });
      const enc = await GhostCrypto.encrypt(contact.sharedKey, meta);
      WS.send({ type: "file_meta", to: activeContact, transferId, payload: enc.ciphertext, nonce: enc.nonce, size: file.size });
      showProgress("Waiting for acceptance…", 0);
      fileInput.value = "";
      document.getElementById("file-preview-img").hidden = true;
      document.getElementById("file-preview-img").src = "";
      document.getElementById("file-preview-name").textContent = "";
      document.getElementById("file-preview").hidden = true;
      return;
    }

    const input = document.getElementById("message-input");
    const text = input.value.trim();
    
    // Validar mensaje antes de enviar
    const validation = validateMessageText(text);
    if (!validation.valid) {
      appendStatus(`Error: ${validation.error}`);
      return;
    }
    
    const encrypted = await GhostCrypto.encrypt(contact.sharedKey, text);
    const sent = WS.send({ type: "text", to: activeContact, payload: encrypted.ciphertext, nonce: encrypted.nonce, timestamp: Date.now() });
    if (!sent) {
      appendStatus("Not connected — message not sent");
      return;
    }
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
    if (transfer) showProgress("Receiving file...", 0);
    _showNextIncomingFile();
  });

  // File incoming: reject
  document.getElementById("file-incoming-reject").addEventListener("click", () => {
    const modal = document.getElementById("file-incoming-modal");
    const transferId = modal.dataset.transferId;
    const from = modal.dataset.from;
    modal.hidden = true;
    WS.send({ type: "file_reject", to: from, transferId });
    const transfer = incomingTransfers.get(transferId);
    if (transfer) clearTimeout(transfer.timeoutId);
    incomingTransfers.delete(transferId);
    _showNextIncomingFile();
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

  // Copy ID — includes a human-readable prefix so the recipient knows what it is
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
    if (confirm("Are you sure you want to refresh your ID? This will disconnect all conversations.")) {
      WS.refreshId();
    }
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
    
    if (!code) {
      appendStatus("Please enter a contact code");
      return;
    }
    
    // Validar código antes de añadir
    if (!isValidUserCode(code)) {
      appendStatus("Error: Invalid contact code format. Use only letters and numbers.");
      return;
    }
    
    if (nickname && !isValidNickname(nickname)) {
      appendStatus("Error: Invalid nickname");
      return;
    }
    
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

    // Validar nombre de archivo
    if (file.name.length > 200) {
      appendStatus("Error: Filename too long (max 200 characters)");
      fileInput.value = "";
      return;
    }
    
    // Verificar tipo de archivo peligroso
    const dangerousExtensions = ['.exe', '.bat', '.cmd', '.sh', '.js', '.vbs'];
    const fileExt = file.name.toLowerCase().split('.').pop();
    if (dangerousExtensions.includes('.' + fileExt)) {
      const proceed = confirm("Warning: This file type could be dangerous. Send anyway?");
      if (!proceed) {
        fileInput.value = "";
        return;
      }
    }
    
    filePreviewName.textContent = `${sanitizeInput(file.name)} (${formatFileSize(file.size)})`;

    if (file.type && file.type.startsWith("image/")) {
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
  const contactName = contacts.get(from)?.nickname ?? from.slice(0, 8) + "…";
  document.getElementById("typing-indicator").textContent = `${sanitizeInput(contactName)} is typing…`;
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
  
  // Sanitizar todo el contenido
  const sanitizedLabel = sanitizeInput(label);
  const sanitizedText = sanitizeInput(text);
  
  div.textContent = `${sanitizedLabel}: ${sanitizedText}`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function appendStatus(text) {
  const msgs = document.getElementById("messages");
  const div = document.createElement("div");
  div.textContent = sanitizeInput(text);
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
  document.getElementById("file-progress-label").textContent = sanitizeInput(label);
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
    showProgress(`Sending ${sanitizeInput(file.name)}`, ((i + 1) / total) * 100);
    // Yield the event loop between chunks to keep the UI responsive
    await new Promise(r => setTimeout(r, 0));
  }

  clearTimeout(transfer.timeoutId);
  appendStatus(`File "${sanitizeInput(file.name)}" sent`);
  hideProgress();
  outgoingTransfers.delete(transferId);
}

function triggerDownload(chunks, name, mime) {
  // Validar nombre de archivo
  const sanitizedName = sanitizeInput(name).replace(/[^a-zA-Z0-9._-]/g, '_');
  
  const blob = new Blob(chunks, { type: mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = sanitizedName.substring(0, 100); // Limitar longitud
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function _showIncomingFileModal(transferId, from, meta, contact) {
  const senderName = contact?.nickname ?? from.slice(0, 8) + "…";
  document.getElementById("file-incoming-sender").textContent = `From: ${sanitizeInput(senderName)}`;
  document.getElementById("file-incoming-info").textContent =
    `${sanitizeInput(meta.name)}  (${formatFileSize(meta.size)})`;
  const modal = document.getElementById("file-incoming-modal");
  modal.dataset.transferId = escapeHtmlAttribute(transferId);
  modal.dataset.from = escapeHtmlAttribute(from);
  modal.hidden = false;
}

function _showNextIncomingFile() {
  if (incomingFileQueue.length === 0) return;
  const { transferId, from, meta } = incomingFileQueue.shift();
  if (!incomingTransfers.has(transferId)) {
    _showNextIncomingFile();
    return;
  }
  const contact = contacts.get(from);
  _showIncomingFileModal(transferId, from, meta, contact);
}
