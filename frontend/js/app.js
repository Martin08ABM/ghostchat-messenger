let id = null;
let peerCode = null;
let connected = false;

document.addEventListener("DOMContentLoaded", () => {
  WS.onOpen(() => {
    WS.onMessage(handleMessage);
    const saved = localStorage.getItem("ghostchat_id");
    if (saved) {
      WS.login(saved);
    } else {
      WS.register();
    }
  });
  WS.connect(`ws://${window.location.host}/ws`);

  // Send message
  document.getElementById("message-form").addEventListener("submit", function(event) {
    event.preventDefault();
    const input = document.getElementById("message-input");
    const text = input.value.trim();
    if (text && peerCode) {
      WS.sendMessage(peerCode, text);
      appendMessage("You", text);
      input.value = "";
    }
  });

  // Refresh ID
  document.getElementById("btn-refresh").addEventListener("click", () => {
    WS.refreshId();
  });

  // Copy ID
  document.getElementById("btn-copy").addEventListener("click", () => {
    if (id) navigator.clipboard.writeText(id);
  });

  // Connect to peer
  document.getElementById("btn-connect-peer").addEventListener("click", () => {
    const input = document.getElementById("peer-input");
    peerCode = input.value.trim() || null;
  });
});

function handleMessage(data) {
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

    case "sended":
      appendMessage(data.from, data.payload);
      break;

    case "delivery_status":
      appendStatus(data.delivered ? "Delivered" : "Not delivered");
      break;

    case "error":
      appendStatus(`Error: ${data.message}`);
      break;
  }
}

function appendMessage(from, text) {
  const messages = document.getElementById("messages");

  if (from == "You") {
    const div = document.createElement("div");
    div.className = "msg msg-sent";
    div.textContent = `${from}: ${text}`;
    messages.appendChild(div);
  } else {
    const div = document.createElement("div");
    div.className = "msg msg-received";
    div.textContent = `${from}: ${text}`;
    messages.appendChild(div);
  }

  messages.scrollTop = messages.scrollHeight
}

function appendStatus(text) {
  const messages = document.getElementById("messages");
  const div = document.createElement("div");
  div.textContent = text;
  div.className = "msg msg-system"
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight
}
