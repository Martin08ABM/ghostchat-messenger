async function generateKeyPair() {
  const PairKey = await window.crypto.subtle.generateKey(
    {
      name: "ECDH",
      namedCurve: "P-256",
    },
    true,
    ["deriveKey", "deriveBits"]
  )
  return PairKey
}

async function exportPublicKey(publicKey) {
  const exported = await window.crypto.subtle.exportKey("raw", publicKey)
  const bytes = new Uint8Array(exported)
  const convert = String.fromCharCode(...bytes)
  return btoa(convert)
}

async function importPublicKey(base64Key) {
  const binaryKey = Uint8Array.from(atob(base64Key), c => c.charCodeAt(0))
  return await window.crypto.subtle.importKey("raw", binaryKey, {name: "ECDH", namedCurve: "P-256"}, true, [])
}

// Returns { key, fingerprint } where fingerprint is a hex string for out-of-band verification
async function deriveSharedKey(privateKey, ownPublicKey, peerPublicKey) {
  // Step 1: Extract raw ECDH shared secret
  const rawBits = await window.crypto.subtle.deriveBits(
    { name: "ECDH", public: peerPublicKey },
    privateKey,
    256
  );

  // Step 2: Import as HKDF key material
  const hkdfKeyMaterial = await window.crypto.subtle.importKey(
    "raw",
    rawBits,
    { name: "HKDF" },
    false,
    ["deriveKey", "deriveBits"]
  );

  // Step 3: Derive salt from both public keys (sorted so both sides compute the same salt)
  const ownRaw  = new Uint8Array(await window.crypto.subtle.exportKey("raw", ownPublicKey));
  const peerRaw = new Uint8Array(await window.crypto.subtle.exportKey("raw", peerPublicKey));
  const [first, second] = [ownRaw, peerRaw].sort((a, b) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  });
  const combined = new Uint8Array(first.length + second.length);
  combined.set(first);
  combined.set(second, first.length);
  const salt = new Uint8Array(await window.crypto.subtle.digest("SHA-256", combined));

  const hkdfParams = { name: "HKDF", hash: "SHA-256", salt };

  // Step 4: Derive AES-256-GCM encryption key
  const key = await window.crypto.subtle.deriveKey(
    { ...hkdfParams, info: new TextEncoder().encode("GhostChat E2E") },
    hkdfKeyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );

  // Step 5: Derive a short fingerprint for manual out-of-band verification
  const fpBits = await window.crypto.subtle.deriveBits(
    { ...hkdfParams, info: new TextEncoder().encode("GhostChat Fingerprint") },
    hkdfKeyMaterial,
    64
  );
  const fingerprint = Array.from(new Uint8Array(fpBits))
    .map(b => b.toString(16).padStart(2, "0"))
    .join(":");

  return { key, fingerprint };
}

// Pad plaintext to a multiple of PADDING_BLOCK bytes to hide message length from the server.
// Format: [2-byte big-endian length][content][zero padding]
const PADDING_BLOCK = 256;

function _pad(plaintext) {
  const encoded = new TextEncoder().encode(plaintext);
  const totalLen = Math.ceil((encoded.length + 2) / PADDING_BLOCK) * PADDING_BLOCK;
  const padded = new Uint8Array(totalLen);
  padded[0] = (encoded.length >> 8) & 0xff;
  padded[1] = encoded.length & 0xff;
  padded.set(encoded, 2);
  return padded;
}

function _unpad(bytes) {
  const len = (bytes[0] << 8) | bytes[1];
  return new TextDecoder().decode(bytes.slice(2, 2 + len));
}

async function encrypt(sharedKey, plaintext) {
  const nonce = window.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await window.crypto.subtle.encrypt({name: "AES-GCM", iv: nonce}, sharedKey, _pad(plaintext));
  return {
    nonce: btoa(String.fromCharCode(...nonce)),
    ciphertext: btoa(String.fromCharCode(...new Uint8Array(ciphertext)))
  };
}

async function decrypt(sharedKey, nonce, ciphertext) {
  const nonceBytes = Uint8Array.from(atob(nonce), c => c.charCodeAt(0));
  const ciphertextBytes = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
  const decrypted = await window.crypto.subtle.decrypt({name: "AES-GCM", iv: nonceBytes}, sharedKey, ciphertextBytes);
  return _unpad(new Uint8Array(decrypted));
}

// Safe base64 encoder for large Uint8Arrays (avoids spread stack overflow)
function _bytesToBase64(bytes) {
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str);
}

// Encrypt raw bytes (for file chunks) — no text padding
async function encryptBytes(sharedKey, bytes) {
  const nonce = window.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, sharedKey, bytes);
  return {
    nonce: _bytesToBase64(nonce),
    ciphertext: _bytesToBase64(new Uint8Array(ciphertext))
  };
}

// Decrypt raw bytes (for file chunks)
async function decryptBytes(sharedKey, nonce, ciphertext) {
  const nonceBytes = Uint8Array.from(atob(nonce), c => c.charCodeAt(0));
  const ciphertextBytes = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
  const decrypted = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv: nonceBytes }, sharedKey, ciphertextBytes);
  return new Uint8Array(decrypted);
}

window.GhostCrypto = { generateKeyPair, exportPublicKey, importPublicKey, deriveSharedKey, encrypt, decrypt, encryptBytes, decryptBytes }