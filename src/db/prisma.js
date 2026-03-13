const { PrismaClient } = require("@prisma/client");

let prisma;

if (process.env.DATABASE_URL) {
  prisma = new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["query", "warn", "error"] : ["warn", "error"],
  });
} else {
  // 沒有 DATABASE_URL 時回傳 null，讓服務可以 graceful fallback
  prisma = null;
}

/**
 * 確認 DB 是否可用
 */
function isDbAvailable() {
  return !!prisma;
}

/**
 * 連線測試
 */
async function testConnection() {
  if (!prisma) return { success: false, error: "DATABASE_URL not set" };
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * 關閉連線
 */
async function disconnect() {
  if (prisma) {
    await prisma.$disconnect();
  }
}

module.exports = { prisma, isDbAvailable, testConnection, disconnect };
