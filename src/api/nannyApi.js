// =============================================
// 保母薪資管理 REST API
//
// 所有端點需要 Authorization: Bearer <ADMIN_TOKEN>
// =============================================

const express = require("express");
const router = express.Router();
const logger = require("../utils/logger");
const { config } = require("../config");
const nannyService = require("../services/nannyService");
const { getHolidays: getBuiltinHolidays } = require("../utils/taiwanHolidays");
const { adminAuthMiddleware } = require("../auth/adminAuth");
const userService = require("../services/userService");

// ========== 認證中間件（支援 JWT + 舊 ADMIN_TOKEN）==========

router.use(adminAuthMiddleware);

// 模組檢查：需要 nanny 模組
async function requireNannyModule(req, res, next) {
  if (req.user) {
    const has = await userService.hasModule(req.user.lineUserId, "nanny");
    if (!has) return res.status(403).json({ error: "保母薪資模組未開啟" });
  }
  next();
}

router.use(requireNannyModule);

// ========== 保母管理 ==========

/**
 * GET /api/nanny/nannies — 列出所有保母
 */
router.get("/nannies", (req, res) => {
  try {
    const nannies = nannyService.getAllNannies();
    res.json({ nannies });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/nanny/nannies — 新增/更新保母
 */
router.post("/nannies", (req, res) => {
  try {
    const data = req.body;
    if (!data.id || !data.name) {
      return res.status(400).json({ error: "id 和 name 為必填" });
    }
    const nanny = nannyService.upsertNanny(data);
    res.json({ success: true, nanny });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * DELETE /api/nanny/nannies/:id — 刪除保母
 */
router.delete("/nannies/:id", (req, res) => {
  try {
    const deleted = nannyService.deleteNanny(req.params.id);
    if (deleted) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: "找不到該保母" });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== 假日管理 ==========

/**
 * GET /api/nanny/holidays/:year — 取得國定假日
 */
router.get("/holidays/:year", (req, res) => {
  try {
    const year = req.params.year;
    const cfg = nannyService.loadConfig();
    const custom = cfg.holidays?.[year] || [];
    const builtin = getBuiltinHolidays(parseInt(year));
    res.json({
      year,
      holidays: custom.length > 0 ? custom : builtin,
      source: custom.length > 0 ? "custom" : "builtin",
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * PUT /api/nanny/holidays/:year — 更新國定假日
 */
router.put("/holidays/:year", (req, res) => {
  try {
    const year = req.params.year;
    const { holidays } = req.body;
    if (!Array.isArray(holidays)) {
      return res.status(400).json({ error: "holidays 必須是陣列" });
    }
    nannyService.updateHolidays(year, holidays);
    res.json({ success: true, year, count: holidays.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== 薪資計算 ==========

/**
 * GET /api/nanny/salary/all/:month — 全員月薪計算
 */
router.get("/salary/all/:month", async (req, res) => {
  try {
    const month = req.params.month; // YYYY-MM
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: "月份格式錯誤，需 YYYY-MM" });
    }
    const result = await nannyService.calculateAllSalaries(month);
    res.json(result);
  } catch (e) {
    logger.error(`[NannyAPI] 全員薪資計算失敗: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/nanny/salary/:id/:month — 單人月薪計算
 */
router.get("/salary/:id/:month", async (req, res) => {
  try {
    const { id, month } = req.params;
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: "月份格式錯誤，需 YYYY-MM" });
    }
    const record = await nannyService.calculateMonthlySalary(id, month);
    res.json(record);
  } catch (e) {
    logger.error(`[NannyAPI] 薪資計算失敗: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ========== 紀錄查詢 ==========

/**
 * GET /api/nanny/records — 歷史紀錄
 */
router.get("/records", (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const records = nannyService.getSalaryRecords(limit);
    res.json({ records });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== 付款管理 ==========

/**
 * PUT /api/nanny/records/:id/paid — 標記已發放
 */
router.put("/records/:id/paid", (req, res) => {
  try {
    const { id } = req.params;
    const { paidAt, amount, note } = req.body || {};
    const record = nannyService.markAsPaid(id, { paidAt, amount, note });
    if (record) {
      res.json({ success: true, record });
    } else {
      res.status(404).json({ error: "找不到該薪資紀錄" });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * PUT /api/nanny/records/:id/unpaid — 取消已發放
 */
router.put("/records/:id/unpaid", (req, res) => {
  try {
    const { id } = req.params;
    const record = nannyService.markAsUnpaid(id);
    if (record) {
      res.json({ success: true, record });
    } else {
      res.status(404).json({ error: "找不到該薪資紀錄" });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
