const express = require("express");
const router = express.Router();
const { adminAuthMiddleware } = require("../auth/adminAuth");
const { prisma, isDbAvailable } = require("../db/prisma");

// 所有路由需要認證
router.use(adminAuthMiddleware);

// ========== 邀請碼管理 ==========

router.get("/invitation-codes", async (req, res) => {
  if (!isDbAvailable()) return res.json({ codes: [] });
  try {
    const codes = await prisma.invitationCode.findMany({
      orderBy: { createdAt: "desc" },
    });
    res.json({ codes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/invitation-codes", async (req, res) => {
  if (!isDbAvailable()) return res.json({ error: "DB not available" });
  try {
    const { code, maxUses, expiresAt } = req.body;
    if (!code) return res.status(400).json({ error: "code 為必填" });
    const created = await prisma.invitationCode.create({
      data: {
        code: code.toUpperCase(),
        maxUses: maxUses || 5,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        createdBy: req.userId || "admin",
      },
    });
    res.json({ code: created });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/invitation-codes/:code", async (req, res) => {
  if (!isDbAvailable()) return res.json({ error: "DB not available" });
  try {
    await prisma.invitationCode.delete({ where: { code: req.params.code } });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== 用戶管理 ==========

router.get("/users", async (req, res) => {
  if (!isDbAvailable()) return res.json({ users: [] });
  try {
    const users = await prisma.user.findMany({
      include: {
        settings: true,
        googleAuth: { select: { email: true, calendarId: true, updatedAt: true } },
        _count: { select: { aiUsageLogs: true, conversationMessages: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ users });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== 全站 AI 用量 ==========

router.get("/ai-usage/summary", async (req, res) => {
  if (!isDbAvailable()) return res.json({ error: "DB not available" });
  try {
    const days = parseInt(req.query.days) || 30;
    const aiUsageService = require("../services/aiUsageService");
    const summary = await aiUsageService.getGlobalUsageSummary(days);
    res.json({ usage: summary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
