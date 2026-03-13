const { prisma, isDbAvailable } = require("../db/prisma");
const logger = require("../utils/logger");

// 費率表（USD per 1M tokens）
const PRICING = {
  "gemini-2.5-flash": { input: 0.15, output: 0.60 },
  "gemini-2.0-flash": { input: 0.10, output: 0.40 },
  "gemini-1.5-flash": { input: 0.075, output: 0.30 },
  "claude-haiku-4-5-20251001": { input: 1.00, output: 5.00 },
  "claude-sonnet-4-20250514": { input: 3.00, output: 15.00 },
};

// 預設費率
const DEFAULT_PRICING = { input: 0.50, output: 1.50 };

/**
 * 記錄 AI 用量
 * @param {string} dbUserId — DB User.id
 * @param {string} provider — "gemini" or "anthropic"
 * @param {string} model — 模型名稱
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @param {string[]} toolsUsed — 使用的工具名稱
 */
async function saveUsage(dbUserId, provider, model, inputTokens, outputTokens, toolsUsed) {
  if (!isDbAvailable() || !dbUserId) return;

  try {
    const pricing = PRICING[model] || DEFAULT_PRICING;
    const estimatedCost = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;

    await prisma.aiUsageLog.create({
      data: {
        userId: dbUserId,
        provider,
        model,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        estimatedCost,
        toolsUsed: toolsUsed?.length > 0 ? toolsUsed.join(",") : null,
      },
    });
  } catch (e) {
    // 用量記錄失敗不影響主流程
    logger.warn(`[AiUsage] 記錄失敗: ${e.message}`);
  }
}

/**
 * 取得用戶 AI 用量摘要
 * @param {string} dbUserId
 * @param {number} days — 過去幾天（預設 30）
 */
async function getUserUsageSummary(dbUserId, days = 30) {
  if (!isDbAvailable()) return null;

  const since = new Date(Date.now() - days * 86400000);

  const logs = await prisma.aiUsageLog.findMany({
    where: { userId: dbUserId, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
  });

  // 匯總
  const summary = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    totalCost: 0,
    requestCount: logs.length,
    byProvider: {},
    dailyBreakdown: {},
  };

  for (const log of logs) {
    summary.totalInputTokens += log.inputTokens;
    summary.totalOutputTokens += log.outputTokens;
    summary.totalTokens += log.totalTokens;
    summary.totalCost += log.estimatedCost;

    // By provider
    if (!summary.byProvider[log.provider]) {
      summary.byProvider[log.provider] = {
        model: log.model,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cost: 0,
        count: 0,
      };
    }
    const bp = summary.byProvider[log.provider];
    bp.inputTokens += log.inputTokens;
    bp.outputTokens += log.outputTokens;
    bp.totalTokens += log.totalTokens;
    bp.cost += log.estimatedCost;
    bp.count++;

    // Daily breakdown
    const dateKey = log.createdAt.toISOString().slice(0, 10);
    if (!summary.dailyBreakdown[dateKey]) {
      summary.dailyBreakdown[dateKey] = { tokens: 0, cost: 0, count: 0 };
    }
    summary.dailyBreakdown[dateKey].tokens += log.totalTokens;
    summary.dailyBreakdown[dateKey].cost += log.estimatedCost;
    summary.dailyBreakdown[dateKey].count++;
  }

  // 四捨五入費用
  summary.totalCost = Math.round(summary.totalCost * 10000) / 10000;
  for (const bp of Object.values(summary.byProvider)) {
    bp.cost = Math.round(bp.cost * 10000) / 10000;
  }

  return summary;
}

/**
 * 取得全站 AI 用量摘要（管理員用）
 */
async function getGlobalUsageSummary(days = 30) {
  if (!isDbAvailable()) return null;

  const since = new Date(Date.now() - days * 86400000);

  const result = await prisma.aiUsageLog.groupBy({
    by: ["userId", "provider"],
    where: { createdAt: { gte: since } },
    _sum: { inputTokens: true, outputTokens: true, totalTokens: true, estimatedCost: true },
    _count: true,
  });

  return result;
}

module.exports = { saveUsage, getUserUsageSummary, getGlobalUsageSummary, PRICING };
