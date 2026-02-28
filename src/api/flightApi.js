// =============================================
// 航班搜尋 REST API（供 LIFF 小程式呼叫）
//
// GET /api/flights/search?origin=TPE&destination=LAX&departDate=2026-03-26&...
// =============================================

const express = require("express");
const router = express.Router();
const amadeusClient = require("../scraper/amadeusClient");
const logger = require("../utils/logger");

/**
 * GET /api/flights/search
 *
 * Query params:
 *   origin       - 出發機場 IATA (required)
 *   destination  - 目的地機場 IATA (required)
 *   departDate   - 出發日期 YYYY-MM-DD (required)
 *   returnDate   - 回程日期 YYYY-MM-DD (optional)
 *   cabinClass   - ECONOMY | PREMIUM_ECONOMY | BUSINESS | FIRST (optional)
 *   airlines     - 航空公司代碼，逗號分隔 CI,BR,JX (optional)
 *   adults       - 成人人數，預設 1 (optional)
 */
router.get("/search", async (req, res) => {
  const startTime = Date.now();

  try {
    const { origin, destination, departDate, returnDate, cabinClass, airlines, adults } = req.query;

    // 驗證必填參數
    if (!origin || !destination || !departDate) {
      return res.status(400).json({
        success: false,
        error: "缺少必填參數：origin, destination, departDate",
      });
    }

    // 驗證日期格式
    if (!/^\d{4}-\d{2}-\d{2}$/.test(departDate)) {
      return res.status(400).json({
        success: false,
        error: "日期格式錯誤，請使用 YYYY-MM-DD",
      });
    }

    const params = {
      origin: origin.toUpperCase(),
      destination: destination.toUpperCase(),
      departDate,
      returnDate: returnDate || null,
      adults: parseInt(adults) || 1,
      cabinClass: cabinClass || null,
    };

    const airlineList = airlines ? airlines.split(",").map((a) => a.trim().toUpperCase()) : [];

    logger.info(`[API] 搜尋 ${params.origin}→${params.destination} ${params.departDate} cabin=${params.cabinClass || "ALL"} airlines=[${airlineList.join(",")}]`);

    // 呼叫 Amadeus API
    if (!amadeusClient.isAvailable()) {
      return res.status(503).json({
        success: false,
        error: "Amadeus API 未設定，無法搜尋航班",
      });
    }

    const result = await amadeusClient.searchFlights(params, airlineList);
    const elapsed = Date.now() - startTime;

    if (!result.success) {
      logger.warn(`[API] 搜尋失敗 (${elapsed}ms): ${result.error}`);
      return res.json({
        success: false,
        error: result.error,
        elapsed,
      });
    }

    // 分離去程/回程
    const outbound = result.flights.filter((f) => f.direction === "outbound");
    const inbound = result.flights.filter((f) => f.direction === "inbound");

    logger.info(`[API] 搜尋成功 (${elapsed}ms): 去程=${outbound.length} 回程=${inbound.length}`);

    res.json({
      success: true,
      query: params,
      outbound: outbound.length > 0 ? outbound : result.flights,
      inbound,
      totalResults: result.flights.length,
      source: "amadeus",
      elapsed,
    });
  } catch (error) {
    const elapsed = Date.now() - startTime;
    logger.error(`[API] 搜尋異常 (${elapsed}ms)`, { error: error.message });
    res.status(500).json({
      success: false,
      error: `伺服器錯誤：${error.message}`,
      elapsed,
    });
  }
});

/**
 * GET /api/flights/airlines
 * 回傳支援的航空公司清單
 */
router.get("/airlines", (req, res) => {
  res.json({
    airlines: [
      { code: "CI", name: "中華航空", color: "#D7177E" },
      { code: "BR", name: "長榮航空", color: "#00694A" },
      { code: "JX", name: "星宇航空", color: "#8B6914" },
      { code: "EK", name: "阿聯酋航空", color: "#D71921" },
      { code: "TK", name: "土耳其航空", color: "#C80815" },
      { code: "CX", name: "國泰航空", color: "#006564" },
      { code: "SQ", name: "新加坡航空", color: "#F2A900" },
    ],
  });
});

module.exports = router;
