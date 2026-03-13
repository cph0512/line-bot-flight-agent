const jwt = require("jsonwebtoken");
const { config } = require("../config");
const { prisma } = require("../db/prisma");

/**
 * 產生後台管理 JWT（24 小時有效）
 * @param {string} lineUserId
 * @returns {string} JWT token
 */
function generateAdminToken(lineUserId) {
  return jwt.sign({ lineUserId }, config.app.sessionSecret, { expiresIn: "24h" });
}

/**
 * 驗證 JWT
 * @param {string} token
 * @returns {Object|null} { lineUserId } 或 null
 */
function verifyAdminToken(token) {
  try {
    return jwt.verify(token, config.app.sessionSecret);
  } catch {
    return null;
  }
}

/**
 * Express middleware：驗證 JWT + 載入用戶
 * 支援兩種傳入方式：
 * 1. Authorization: Bearer <token>
 * 2. ?token=<token> (URL query)
 *
 * 同時向下相容舊的 ADMIN_TOKEN（全域密碼）
 */
async function adminAuthMiddleware(req, res, next) {
  // 取得 token
  let token = null;
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  } else if (req.query?.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ error: "未提供認證 token" });
  }

  // 1. 嘗試舊的 ADMIN_TOKEN（向下相容）
  if (config.nanny?.adminToken && token === config.nanny.adminToken) {
    // 舊模式：使用 owner 帳號
    if (prisma && config.app.ownerLineUserId) {
      const user = await prisma.user.findUnique({
        where: { lineUserId: config.app.ownerLineUserId },
        include: { settings: true },
      });
      if (user) {
        req.userId = user.id;
        req.user = user;
        req.authMode = "legacy";
        return next();
      }
    }
    // DB 不可用時仍然允許（legacy mode）
    req.userId = null;
    req.authMode = "legacy-no-db";
    return next();
  }

  // 2. JWT 驗證
  const payload = verifyAdminToken(token);
  if (!payload) {
    return res.status(401).json({ error: "Token 無效或已過期" });
  }

  // 3. 載入用戶
  if (prisma) {
    const user = await prisma.user.findUnique({
      where: { lineUserId: payload.lineUserId },
      include: { settings: true },
    });
    if (!user) {
      return res.status(401).json({ error: "用戶不存在" });
    }
    if (user.status !== "ACTIVE") {
      return res.status(403).json({ error: "帳號未啟用" });
    }
    req.userId = user.id;
    req.user = user;
    req.authMode = "jwt";
  } else {
    req.userId = null;
    req.authMode = "jwt-no-db";
  }

  next();
}

/**
 * 超級管理員 middleware（僅 Owner 可訪問）
 * 需在 adminAuthMiddleware 之後使用
 */
async function superAdminMiddleware(req, res, next) {
  // 先確認已通過基本認證
  if (!req.user) {
    return res.status(401).json({ error: "未認證" });
  }

  // 檢查是否為 Owner
  if (!config.app.ownerLineUserId || req.user.lineUserId !== config.app.ownerLineUserId) {
    return res.status(403).json({ error: "僅限超級管理員" });
  }

  req.isSuperAdmin = true;
  next();
}

module.exports = { generateAdminToken, verifyAdminToken, adminAuthMiddleware, superAdminMiddleware };
