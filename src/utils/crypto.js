const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

/**
 * 從 SESSION_SECRET 衍生 32-byte key
 */
function deriveKey(secret) {
  return crypto.createHash("sha256").update(secret).digest();
}

/**
 * 加密文字（AES-256-GCM）
 * @returns {string} base64 encoded: iv + tag + ciphertext
 */
function encrypt(text, secret) {
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, "utf8");
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  const tag = cipher.getAuthTag();

  // iv(16) + tag(16) + ciphertext
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

/**
 * 解密文字（AES-256-GCM）
 * @param {string} data base64 encoded
 * @returns {string} 原始文字
 */
function decrypt(data, secret) {
  const key = deriveKey(secret);
  const buf = Buffer.from(data, "base64");

  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(ciphertext);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString("utf8");
}

module.exports = { encrypt, decrypt };
