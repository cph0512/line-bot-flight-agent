const crypto = require("crypto");

// In-memory store: nonce -> { lineUserId, expiresAt }
const nonceStore = new Map();

const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // sweep every 60s

/**
 * Generate a single-use, short-lived nonce for OAuth bootstrap.
 * @param {string} lineUserId
 * @returns {string} nonce
 */
function createNonce(lineUserId) {
  const nonce = crypto.randomBytes(32).toString("hex");
  nonceStore.set(nonce, { lineUserId, expiresAt: Date.now() + NONCE_TTL_MS });
  return nonce;
}

/**
 * Consume a nonce — returns lineUserId if valid, null otherwise.
 * The nonce is deleted on use (single-use).
 * @param {string} nonce
 * @returns {string|null} lineUserId
 */
function consumeNonce(nonce) {
  const entry = nonceStore.get(nonce);
  if (!entry) return null;
  nonceStore.delete(nonce);
  if (Date.now() > entry.expiresAt) return null;
  return entry.lineUserId;
}

// Periodic cleanup of expired nonces
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of nonceStore) {
    if (now > val.expiresAt) nonceStore.delete(key);
  }
}, CLEANUP_INTERVAL_MS).unref();

module.exports = { createNonce, consumeNonce };
