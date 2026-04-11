// ── State ────────────────────────────────────────────────────────────────────
let id = null;
let connected = false;
let typingHideTimeout = null;

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

  // Send message
  document.getElementById("message-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!activeContact) return;
    const contact = contacts.get(activeContact);
    if (!contact?.sharedKey) return;

    const input = document.getElementById("message-input");
    const text = input.value.trim();
    if (!text) return;

    const encrypted = await GhostCrypto.encrypt(contact.sharedKey, text);
    WS.send({ type: "text", to: activeContact, payload: encrypted.ciphertext, nonce: encrypted.nonce, timestamp: Date.now() });
    messages.get(activeContact).push({ from: "You", text, timestamp: Date.now() });
    appendMessageElement("You", text);
    input.value = "";
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
