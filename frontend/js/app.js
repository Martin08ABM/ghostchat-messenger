let id = null;
let peerCode = null;
let connected = false;
let keyPair = null;
let sharedKey = null;
let typingHideTimeout = null;

document.addEventListener("DOMContentLoaded", () => {
  // Apply saved theme
  if (localStorage.getItem("ghostchat_theme") === "light") {
    document.body.classList.add("light");
  }

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
    sharedKey = null;
  });

  WS.connect(`ws://${window.location.host}/ws`);

  // Send message
  document.getElementById("message-form").addEventListener("submit", async function(event) {
    event.preventDefault();
    const input = document.getElementById("message-input");
    const text = input.value.trim();
    if (text && peerCode && sharedKey) {
      const encrypted = await GhostCrypto.encrypt(sharedKey, text);
      WS.send({ type: "text", to: peerCode, payload: encrypted.ciphertext, nonce: encrypted.nonce, timestamp: Date.now() });
      appendMessage("You", text);
      input.value = "";
    }
  });

  // Typing indicator — debounced: sends at most once every 2 seconds
  let typingSent = false;
  let typingCooldown = null;
  document.getElementById("message-input").addEventListener("input", () => {
    if (!peerCode || !sharedKey) return;
    if (!typingSent) {
      WS.sendTyping(peerCode);
      typingSent = true;
    }
    clearTimeout(typingCooldown);
    typingCooldown = setTimeout(() => { typingSent = false; }, 2000);
  });

  // Refresh ID
  document.getElementById("btn-refresh").addEventListener("click", () => {
    WS.refreshId();
  });

  // Copy ID
  document.getElementById("btn-copy").addEventListener("click", () => {
    if (id) navigator.clipboard.writeText(id);
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

  // Theme toggle
  document.getElementById("btn-theme").addEventListener("click", () => {
    document.body.classList.toggle("light");
    localStorage.setItem("ghostchat_theme", document.body.classList.contains("light") ? "light" : "dark");
  });

  // Connect to peer
  document.getElementById("btn-connect-peer").addEventListener("click", async () => {
    const input = document.getElementById("peer-input");
    peerCode = input.value.trim() || null;
    if (!peerCode) return;

    keyPair = await GhostCrypto.generateKeyPair();
    const publicKeyBase64 = await GhostCrypto.exportPublicKey(keyPair.publicKey);
    WS.send({ type: "key_exchange", to: peerCode, payload: publicKeyBase64 });
  });
});

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

    case "key_exchange":
      (async () => {
        if (!keyPair) {
          keyPair = await GhostCrypto.generateKeyPair();
          const publicKeyBase64 = await GhostCrypto.exportPublicKey(keyPair.publicKey);
          WS.send({ type: "key_exchange", to: data.from, payload: publicKeyBase64 });
        }
        const peerPublicKey = await GhostCrypto.importPublicKey(data.payload);
        sharedKey = await GhostCrypto.deriveSharedKey(keyPair.privateKey, peerPublicKey);
        if (!peerCode) peerCode = data.from;
        appendStatus("E2E encryption activated");
      })();
      break;

    case "sended":
      (async () => {
        const text = await GhostCrypto.decrypt(sharedKey, data.nonce, data.payload);
        clearTyping();
        appendMessage(data.from, text);
      })();
      break;

    case "typing":
      showTyping(data.from);
      break;

    case "delivery_status":
      appendStatus(data.delivered ? "Delivered" : "Not delivered");
      break;

    case "error":
      appendStatus(`Error: ${data.message}`);
      break;
  }
}

function showTyping(from) {
  document.getElementById("typing-indicator").textContent = `${from.slice(0, 8)}... is typing`;
  clearTimeout(typingHideTimeout);
  typingHideTimeout = setTimeout(clearTyping, 3000);
}

function clearTyping() {
  document.getElementById("typing-indicator").textContent = "";
}

function appendMessage(from, text) {
  const messages = document.getElementById("messages");
  const div = document.createElement("div");
  div.className = from === "You" ? "msg msg-sent" : "msg msg-received";
  div.textContent = `${from}: ${text}`;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

function appendStatus(text) {
  const messages = document.getElementById("messages");
  const div = document.createElement("div");
  div.textContent = text;
  div.className = "msg msg-system";
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}
