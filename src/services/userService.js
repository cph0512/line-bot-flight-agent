const { prisma, isDbAvailable } = require("../db/prisma");
const logger = require("../utils/logger");

/**
 * 自動建立或取得用戶
 * @param {string} lineUserId
 * @param {Object} profile — { displayName, pictureUrl } (optional)
 * @returns {Object|null} User record
 */
async function findOrCreateUser(lineUserId, profile = {}) {
  if (!isDbAvailable()) return null;

  try {
    let user = await prisma.user.findUnique({ where: { lineUserId } });
    if (user) {
      // 更新 displayName 如果有
      if (profile.displayName && profile.displayName !== user.displayName) {
        user = await prisma.user.update({
          where: { lineUserId },
          data: { displayName: profile.displayName, pictureUrl: profile.pictureUrl || user.pictureUrl },
        });
      }
      return user;
    }

    // 建立新用戶（PENDING 狀態）
    user = await prisma.user.create({
      data: {
        lineUserId,
        displayName: profile.displayName || null,
        pictureUrl: profile.pictureUrl || null,
        status: "PENDING",
        settings: {
          create: {},
        },
      },
      include: { settings: true },
    });

    logger.info(`[User] 新用戶建立: ${lineUserId.slice(-6)} (${profile.displayName || "unknown"})`);
    return user;
  } catch (e) {
    logger.error(`[User] findOrCreateUser 失敗: ${e.message}`);
    return null;
  }
}

/**
 * 驗證邀請碼並啟用用戶
 * @param {string} lineUserId
 * @param {string} code
 * @returns {Object} { success, message }
 */
async function activateUser(lineUserId, code) {
  if (!isDbAvailable()) return { success: false, message: "系統暫時無法使用" };

  try {
    // 檢查邀請碼
    const invitation = await prisma.invitationCode.findUnique({ where: { code: code.toUpperCase() } });

    if (!invitation) {
      return { success: false, message: "邀請碼無效，請確認後重新輸入。" };
    }

    if (invitation.expiresAt && invitation.expiresAt < new Date()) {
      return { success: false, message: "邀請碼已過期。" };
    }

    if (invitation.usedCount >= invitation.maxUses) {
      return { success: false, message: "邀請碼已達使用上限。" };
    }

    // 檢查用戶
    const user = await prisma.user.findUnique({ where: { lineUserId } });
    if (!user) {
      return { success: false, message: "用戶不存在，請先加入好友。" };
    }

    if (user.status === "ACTIVE") {
      return { success: false, message: "你的帳號已經啟用囉！" };
    }

    // 啟用用戶
    await prisma.user.update({
      where: { lineUserId },
      data: {
        status: "ACTIVE",
        activatedAt: new Date(),
      },
    });

    // 更新邀請碼使用次數
    await prisma.invitationCode.update({
      where: { code: code.toUpperCase() },
      data: { usedCount: { increment: 1 } },
    });

    logger.info(`[User] 用戶啟用成功: ${lineUserId.slice(-6)} code=${code}`);
    return {
      success: true,
      message: "帳號啟用成功！你現在可以使用所有功能了。\n\n輸入「綁定行事曆」來連結你的 Google 行事曆。",
    };
  } catch (e) {
    logger.error(`[User] activateUser 失敗: ${e.message}`);
    return { success: false, message: "啟用失敗，請稍後再試。" };
  }
}

/**
 * 取得用戶（含設定、OAuth 狀態）
 */
async function getUserByLineId(lineUserId) {
  if (!isDbAvailable()) return null;

  return prisma.user.findUnique({
    where: { lineUserId },
    include: {
      settings: true,
      googleAuth: { select: { calendarId: true, email: true } },
      briefingConfig: true,
    },
  });
}

/**
 * 快速檢查用戶是否已啟用
 */
async function isActivated(lineUserId) {
  if (!isDbAvailable()) return true; // DB 不可用時預設允許（向下相容）

  const user = await prisma.user.findUnique({
    where: { lineUserId },
    select: { status: true },
  });

  return user?.status === "ACTIVE";
}

/**
 * 取得用戶的 DB ID（從 lineUserId）
 */
async function getDbUserId(lineUserId) {
  if (!isDbAvailable()) return null;

  const user = await prisma.user.findUnique({
    where: { lineUserId },
    select: { id: true },
  });

  return user?.id || null;
}

module.exports = {
  findOrCreateUser,
  activateUser,
  getUserByLineId,
  isActivated,
  getDbUserId,
};
