const { google } = require("googleapis");
const { config } = require("../config");
const { encrypt, decrypt } = require("../utils/crypto");
const { prisma } = require("../db/prisma");
const logger = require("../utils/logger");

const SCOPES = ["https://www.googleapis.com/auth/calendar"];

/**
 * 建立 OAuth2 client
 */
function createOAuth2Client() {
  if (!config.googleOAuth.clientId || !config.googleOAuth.clientSecret) {
    return null;
  }
  const redirectUri = `${config.app.url}/auth/google/callback`;
  return new google.auth.OAuth2(
    config.googleOAuth.clientId,
    config.googleOAuth.clientSecret,
    redirectUri
  );
}

/**
 * 檢查 OAuth 是否可用
 */
function isAvailable() {
  return !!(config.googleOAuth.clientId && config.googleOAuth.clientSecret);
}

/**
 * 產生 Google 授權 URL
 * @param {string} lineUserId — LINE 用戶 ID（會加密後放在 state 參數）
 */
function generateAuthUrl(lineUserId) {
  const client = createOAuth2Client();
  if (!client) throw new Error("Google OAuth not configured");

  const state = encrypt(lineUserId, config.app.sessionSecret);

  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state,
  });
}

/**
 * 用授權碼交換 tokens
 * @param {string} code — Google 回傳的 authorization code
 * @returns {Object} { tokens, lineUserId }
 */
async function exchangeCode(code, state) {
  const client = createOAuth2Client();
  if (!client) throw new Error("Google OAuth not configured");

  // 解密 state 得到 lineUserId
  const lineUserId = decrypt(state, config.app.sessionSecret);

  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  // 取得用戶的所有行事曆
  const calendar = google.calendar({ version: "v3", auth: client });
  let calendarId = "primary";
  let email = null;
  let allCalendars = [];
  try {
    const calendarList = await calendar.calendarList.list();
    const items = calendarList.data.items || [];
    const primary = items.find((c) => c.primary);
    if (primary) {
      calendarId = primary.id;
      email = primary.id;
    }
    // 收集非主要行事曆（排除只有空閒/忙碌權限的）
    allCalendars = items
      .filter((c) => !c.primary && c.accessRole !== "freeBusyReader")
      .map((c) => ({
        calendarId: c.id,
        name: c.summaryOverride || c.summary || c.id,
      }));
  } catch (e) {
    logger.warn("[OAuth] 無法讀取行事曆列表", { error: e.message });
  }

  return { tokens, lineUserId, calendarId, email, allCalendars };
}

/**
 * 儲存 OAuth tokens 到 DB（加密 refresh token）
 */
async function saveTokens(lineUserId, tokens, calendarId, email) {
  if (!prisma) throw new Error("Database not available");

  const user = await prisma.user.findUnique({ where: { lineUserId } });
  if (!user) throw new Error(`User not found: ${lineUserId}`);

  const encryptedAccess = encrypt(tokens.access_token, config.app.sessionSecret);
  const encryptedRefresh = encrypt(tokens.refresh_token, config.app.sessionSecret);

  await prisma.googleAuth.upsert({
    where: { userId: user.id },
    update: {
      accessToken: encryptedAccess,
      refreshToken: encryptedRefresh,
      tokenExpiry: new Date(tokens.expiry_date),
      calendarId,
      email,
    },
    create: {
      userId: user.id,
      accessToken: encryptedAccess,
      refreshToken: encryptedRefresh,
      tokenExpiry: new Date(tokens.expiry_date),
      calendarId,
      email,
    },
  });

  logger.info(`[OAuth] Tokens 已儲存 user=${lineUserId.slice(-6)} calendar=${calendarId}`);
}

/**
 * 取得用戶的 OAuth2 calendar client（自動 refresh expired tokens）
 * @param {string} userId — DB User.id
 * @returns {Object|null} google.calendar client 或 null
 */
async function getCalendarClientForUser(userId) {
  if (!prisma) return null;

  const auth = await prisma.googleAuth.findUnique({ where: { userId } });
  if (!auth) return null;

  const client = createOAuth2Client();
  if (!client) return null;

  const accessToken = decrypt(auth.accessToken, config.app.sessionSecret);
  const refreshToken = decrypt(auth.refreshToken, config.app.sessionSecret);

  client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
    expiry_date: auth.tokenExpiry.getTime(),
  });

  // 如果 token 即將過期（5 分鐘內），先 refresh
  if (auth.tokenExpiry.getTime() < Date.now() + 5 * 60 * 1000) {
    try {
      const { credentials } = await client.refreshAccessToken();
      client.setCredentials(credentials);

      // 更新 DB
      await prisma.googleAuth.update({
        where: { userId },
        data: {
          accessToken: encrypt(credentials.access_token, config.app.sessionSecret),
          tokenExpiry: new Date(credentials.expiry_date),
        },
      });
      logger.info(`[OAuth] Token refreshed for user=${userId.slice(-6)}`);
    } catch (e) {
      logger.error(`[OAuth] Token refresh 失敗 user=${userId.slice(-6)}`, { error: e.message });
      return null;
    }
  }

  return google.calendar({ version: "v3", auth: client });
}

/**
 * 檢查用戶是否已綁定 Google Calendar
 * @param {string} userId — DB User.id
 */
async function hasCalendarLinked(userId) {
  if (!prisma) return false;
  const auth = await prisma.googleAuth.findUnique({ where: { userId } });
  return !!auth;
}

/**
 * 解除用戶的 Google Calendar 綁定
 */
async function unlinkCalendar(userId) {
  if (!prisma) return;
  await prisma.googleAuth.delete({ where: { userId } }).catch(() => {});
}

/**
 * 列出用戶 Google 帳號下的所有行事曆（用於重新同步）
 * @param {string} dbUserId — DB User.id
 * @returns {Array} [{ calendarId, name, primary }]
 */
async function listCalendarsForUser(dbUserId) {
  const client = await getCalendarClientForUser(dbUserId);
  if (!client) return [];
  try {
    const calendarList = await client.calendarList.list();
    const items = calendarList.data.items || [];
    return items
      .filter((c) => !c.primary && c.accessRole !== "freeBusyReader")
      .map((c) => ({
        calendarId: c.id,
        name: c.summaryOverride || c.summary || c.id,
      }));
  } catch (e) {
    logger.warn("[OAuth] listCalendarsForUser failed", { error: e.message });
    return [];
  }
}

module.exports = {
  isAvailable,
  generateAuthUrl,
  exchangeCode,
  saveTokens,
  getCalendarClientForUser,
  hasCalendarLinked,
  unlinkCalendar,
  listCalendarsForUser,
};
