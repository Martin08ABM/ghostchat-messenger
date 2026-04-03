let websocket = null;
let callback = null;
let onOpenCallback = null;

function connect(url) {
  websocket = new WebSocket(url)

  websocket.onopen = function() {
    console.log("Websocket runs successfully");
    if (onOpenCallback) onOpenCallback();
  }
  websocket.onmessage = function(event) {
    const parsed = JSON.parse(event.data);
    if (callback !== null) {
      callback(parsed);
    }
  }
  websocket.onclose = function() {
    console.log("The websocket now is closed");
  }
  websocket.onerror = function(error) {
    console.log("Websocket error: " + error);
  }
}

function send(data) {
  if (websocket != null && websocket.readyState === WebSocket.OPEN) {
    websocket.send(JSON.stringify(data));
  }
}

function register() {
  send({ type: "register" })
}

function login(id) {
  send({ type: "login", id: id })
}

function refreshId() {
  send({ type: "refresh_id" })
}

function sendMessage(to, payload) {
  send({ type: "text", to: to, payload: payload, timestamp: Date.now() })
}

function ping() {
  send({ type: "ping" })
}

function onMessage(cb) {
  callback = cb;
}

function onOpen(cb) {
  onOpenCallback = cb;
}

window.WS = { connect, send, register, login, refreshId, sendMessage, ping, onMessage, onOpen }