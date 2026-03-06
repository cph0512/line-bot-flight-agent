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

// ========== 認證中間件 ==========

function authMiddleware(req, res, next) {
  const token = config.nanny?.adminToken;
  if (!token) {
    return res.status(500).json({ error: "ADMIN_TOKEN 未設定" });
  }

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "需要認證" });
  }

  if (auth.slice(7) !== token) {
    return res.status(403).json({ error: "認證失敗" });
  }

  next();
}

router.use(authMiddleware);

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

module.exports = router;
