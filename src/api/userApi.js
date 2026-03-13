const express = require("express");
const router = express.Router();
const { adminAuthMiddleware } = require("../auth/adminAuth");
const { prisma, isDbAvailable } = require("../db/prisma");
const aiUsageService = require("../services/aiUsageService");
const userService = require("../services/userService");

// 所有路由需要認證
router.use(adminAuthMiddleware);

// ========== 用戶資料 ==========

router.get("/profile", async (req, res) => {
  if (!req.userId || !isDbAvailable()) {
    return res.json({ error: "Not available" });
  }
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      include: {
        settings: true,
        googleAuth: { select: { calendarId: true, email: true, updatedAt: true } },
        briefingConfig: true,
      },
    });
    res.json({ user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== 用戶設定 ==========

router.get("/settings", async (req, res) => {
  if (!req.userId || !isDbAvailable()) return res.json({ error: "Not available" });
  try {
    const settings = await prisma.userSettings.findUnique({ where: { userId: req.userId } });
    res.json({ settings });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/settings", async (req, res) => {
  if (!req.userId || !isDbAvailable()) return res.json({ error: "Not available" });
  try {
    const { defaultCity, timezone, eventReminderMin, eventReminderOrigin } = req.body;
    const data = {};
    if (defaultCity !== undefined) data.defaultCity = defaultCity;
    if (timezone !== undefined) data.timezone = timezone;
    if (eventReminderMin !== undefined) data.eventReminderMin = parseInt(eventReminderMin);
    if (eventReminderOrigin !== undefined) data.eventReminderOrigin = eventReminderOrigin;

    const settings = await prisma.userSettings.update({
      where: { userId: req.userId },
      data,
    });
    res.json({ settings });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== 模組清單（唯讀）==========

router.get("/modules", async (req, res) => {
  if (!req.user) return res.json({ modules: [] });
  try {
    const modules = await userService.getModules(req.user.lineUserId);
    res.json({ modules });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== 行事曆狀態 ==========

router.get("/calendar/status", async (req, res) => {
  if (!req.userId || !isDbAvailable()) return res.json({ linked: false });
  try {
    const auth = await prisma.googleAuth.findUnique({
      where: { userId: req.userId },
      select: { calendarId: true, email: true, updatedAt: true },
    });
    const familyCalendars = await prisma.familyCalendar.findMany({
      where: { userId: req.userId },
    });
    res.json({ linked: !!auth, calendar: auth, familyCalendars });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/calendar/disconnect", async (req, res) => {
  if (!req.userId || !isDbAvailable()) return res.json({ error: "Not available" });
  try {
    await prisma.googleAuth.delete({ where: { userId: req.userId } }).catch(() => {});
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== 其他行事曆 ==========

router.get("/family-calendars", async (req, res) => {
  if (!req.userId || !isDbAvailable()) return res.json({ calendars: [] });
  try {
    const calendars = await prisma.familyCalendar.findMany({ where: { userId: req.userId } });
    res.json({ calendars });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/family-calendars", async (req, res) => {
  if (!req.userId || !isDbAvailable()) return res.json({ error: "Not available" });
  try {
    const { name, calendarId } = req.body;
    if (!name || !calendarId) return res.status(400).json({ error: "name 和 calendarId 為必填" });
    const cal = await prisma.familyCalendar.create({
      data: { userId: req.userId, name, calendarId },
    });
    res.json({ calendar: cal });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/family-calendars/:id", async (req, res) => {
  if (!req.userId || !isDbAvailable()) return res.json({ error: "Not available" });
  try {
    await prisma.familyCalendar.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 從 Google 重新同步行事曆列表
router.post("/calendar/sync", async (req, res) => {
  if (!req.userId || !isDbAvailable()) return res.json({ error: "Not available" });
  try {
    const { listCalendarsForUser } = require("../auth/googleOAuth");
    const calendars = await listCalendarsForUser(req.userId);
    if (!calendars || calendars.length === 0) {
      return res.json({ synced: 0, calendars: [] });
    }
    for (const cal of calendars) {
      await prisma.familyCalendar.upsert({
        where: { userId_calendarId: { userId: req.userId, calendarId: cal.calendarId } },
        update: { name: cal.name },
        create: {
          userId: req.userId,
          name: cal.name,
          calendarId: cal.calendarId,
          enabled: true,
          autoDiscovered: true,
        },
      });
    }
    const allCals = await prisma.familyCalendar.findMany({ where: { userId: req.userId } });
    res.json({ synced: calendars.length, calendars: allCals });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 啟用/停用行事曆
router.put("/family-calendars/:id/toggle", async (req, res) => {
  if (!req.userId || !isDbAvailable()) return res.json({ error: "Not available" });
  try {
    const cal = await prisma.familyCalendar.findUnique({ where: { id: req.params.id } });
    if (!cal || cal.userId !== req.userId) return res.status(404).json({ error: "Not found" });
    const updated = await prisma.familyCalendar.update({
      where: { id: req.params.id },
      data: { enabled: !cal.enabled },
    });
    res.json({ calendar: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== AI 用量 ==========

router.get("/ai-usage", async (req, res) => {
  if (!req.userId || !isDbAvailable()) return res.json({ error: "Not available" });
  try {
    const days = parseInt(req.query.days) || 30;
    const summary = await aiUsageService.getUserUsageSummary(req.userId, days);
    res.json({ usage: summary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== 晨報設定 ==========

router.get("/briefing", async (req, res) => {
  if (!req.userId || !isDbAvailable()) return res.json({ config: null });
  try {
    const config = await prisma.briefingConfig.findUnique({ where: { userId: req.userId } });
    res.json({ config });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/briefing", async (req, res) => {
  if (!req.userId || !isDbAvailable()) return res.json({ error: "Not available" });
  try {
    const { enabled, time, cities, newsSections } = req.body;
    const data = {};
    if (enabled !== undefined) data.enabled = !!enabled;
    if (time !== undefined) data.time = time;
    if (cities !== undefined) data.cities = cities;
    if (newsSections !== undefined) data.newsSections = newsSections;

    const config = await prisma.briefingConfig.upsert({
      where: { userId: req.userId },
      update: data,
      create: { userId: req.userId, ...data },
    });
    res.json({ config });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== 通勤路線 ==========

router.get("/commute/routes", async (req, res) => {
  if (!req.userId || !isDbAvailable()) return res.json({ routes: [] });
  try {
    const routes = await prisma.commuteRoute.findMany({ where: { userId: req.userId } });
    res.json({ routes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/commute/routes", async (req, res) => {
  if (!req.userId || !isDbAvailable()) return res.json({ error: "Not available" });
  try {
    const { name, origin, destination, notifyTime, weekdayOnly } = req.body;
    if (!name || !origin || !destination) return res.status(400).json({ error: "name, origin, destination 為必填" });
    const route = await prisma.commuteRoute.create({
      data: {
        userId: req.userId,
        name,
        origin,
        destination,
        notifyTime: notifyTime || "08:15",
        weekdayOnly: weekdayOnly !== false,
      },
    });
    res.json({ route });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/commute/routes/:id", async (req, res) => {
  if (!req.userId || !isDbAvailable()) return res.json({ error: "Not available" });
  try {
    await prisma.commuteRoute.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
