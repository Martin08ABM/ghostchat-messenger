let websocket = null;
let callback = null;
let onOpenCallback = null;
let onDisconnectCallback = null;
let wsUrl = null;
let reconnectAttempts = 0;

function connect(url) {
  wsUrl = url;
  _createSocket();
}

function _createSocket() {
  websocket = new WebSocket(wsUrl);

  websocket.onopen = function () {
    reconnectAttempts = 0;
    if (onOpenCallback) onOpenCallback();
  };

  websocket.onmessage = function (event) {
    const parsed = JSON.parse(event.data);
    if (callback) callback(parsed);
  };

  websocket.onclose = function () {
    if (onDisconnectCallback) onDisconnectCallback();
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
    reconnectAttempts++;
    setTimeout(_createSocket, delay);
  };

  websocket.onerror = function () {};
}

function send(data) {
  if (websocket && websocket.readyState === WebSocket.OPEN) {
    websocket.send(JSON.stringify(data));
    return true;
  }
  return false;
}

function register() { send({ type: "register" }); }
function login(id) { send({ type: "login", id }); }
function refreshId() { send({ type: "refresh_id" }); }
function sendTyping(to) { send({ type: "typing", to }); }
function ping() { send({ type: "ping" }); }
function onMessage(cb) { callback = cb; }
function onOpen(cb) { onOpenCallback = cb; }
function onDisconnect(cb) { onDisconnectCallback = cb; }

window.WS = { connect, send, register, login, refreshId, sendTyping, ping, onMessage, onOpen, onDisconnect };
