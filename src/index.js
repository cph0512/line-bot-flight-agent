const express = require("express");
const path = require("path");
const { config, validateConfig } = require("./config");
const { lineMiddleware } = require("./line/lineClient");
const { handleWebhookEvents } = require("./line/lineHandler");
const { shutdown, testBrowserLaunch } = require("./scraper/browserManager");
const amadeusClient = require("./scraper/amadeusClient");
const flightApi = require("./api/flightApi");
const { weatherService, newsService, calendarService, briefingService, googleFlightsService } = require("./services");
const logger = require("./utils/logger");

// ========== 全域錯誤處理（防止 server 無聲崩潰）==========
process.on("uncaughtException", (err) => {
  logger.error("[FATAL] uncaughtException", { error: err.message, stack: err.stack });
  console.error("[FATAL] uncaughtException:", err);
});

process.on("unhandledRejection", (reason, promise) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  logger.error("[FATAL] unhandledRejection", { error: msg });
  console.error("[FATAL] unhandledRejection:", reason);
});

// 檢查設定
validateConfig();

const app = express();

// ========== 健康檢查 + 診斷 ==========
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    name: "LINE 全能家庭 AI 管家 v6",
    ai_primary: config.gemini.apiKey ? `Gemini ${config.gemini.model}` : "not configured",
    ai_fallback: config.anthropic.apiKey ? `Anthropic ${config.anthropic.model}` : "not configured",
    uptime: Math.round(process.uptime()) + "s",
    memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + "MB",
    amadeus: amadeusClient.isAvailable() ? "configured" : "not configured",
    googleFlights: googleFlightsService.isAvailable() ? "enabled" : "disabled (no RAPIDAPI_KEY)",
    weather: weatherService.isAvailable() ? "enabled" : "disabled",
    news: newsService.isAvailable() ? "enabled" : "disabled",
    calendar: calendarService.isAvailable() ? "enabled" : "disabled",
    briefing: briefingService.isAvailable() ? "enabled" : "disabled",
  });
});

// 完整診斷端點 - 一次檢查所有組件
app.get("/health", async (req, res) => {
  const report = {
    timestamp: new Date().toISOString(),
    server: "ok",
    env: {},
    anthropic: "untested",
    amadeus: "untested",
    browser: "untested",
  };

  // 1. 環境變數
  report.env.LINE_CHANNEL_ACCESS_TOKEN = config.line.channelAccessToken ? "set" : "MISSING";
  report.env.LINE_CHANNEL_SECRET = config.line.channelSecret ? "set" : "MISSING";
  // AI 模型設定
  if (config.gemini.apiKey) {
    report.env.AI_ENGINE = "Gemini";
    report.env.GEMINI_MODEL = config.gemini.model;
  } else {
    report.env.AI_ENGINE = "Anthropic";
    report.env.ANTHROPIC_MODEL = config.anthropic.model;
  }
  report.env.AMADEUS_CLIENT_ID = config.amadeus.clientId ? "set" : "MISSING";
  report.env.AMADEUS_CLIENT_SECRET = config.amadeus.clientSecret ? "set" : "MISSING";
  report.env.AMADEUS_ENV = config.amadeus.production ? "production" : "test";
  report.env.BROWSER_HEADLESS = String(config.browser.headless);
  report.env.BROWSER_MAX_PAGES = config.browser.maxPages;

  // 2. 測試 AI API 是否可用
  if (config.gemini.apiKey) {
    try {
      const { GoogleGenAI } = require("@google/genai");
      const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
      const testRes = await ai.models.generateContent({
        model: config.gemini.model,
        contents: "reply OK",
      });
      const text = testRes.text || "";
      report.ai = `Gemini ok (response="${text.slice(0, 20)}")`;
    } catch (e) {
      report.ai = `Gemini FAIL: ${e.message}`;
    }
  } else {
    try {
      const Anthropic = require("@anthropic-ai/sdk").default;
      const client = new Anthropic({ apiKey: config.anthropic.apiKey });
      const testRes = await client.messages.create({
        model: config.anthropic.model,
        max_tokens: 30,
        messages: [{ role: "user", content: "reply OK" }],
      });
      const text = testRes.content?.[0]?.text || "";
      report.ai = `Anthropic ok (response="${text.slice(0, 20)}")`;
    } catch (e) {
      report.ai = `Anthropic FAIL: ${e.message}`;
    }
  }

  // 3. 測試 Amadeus API 是否可用
  if (amadeusClient.isAvailable()) {
    try {
      const amadeusTest = await amadeusClient.testConnection();
      report.amadeus = amadeusTest.success
        ? `ok (${amadeusTest.message})`
        : `FAIL: ${amadeusTest.error}`;
    } catch (e) {
      report.amadeus = `FAIL: ${e.message}`;
    }
  } else {
    report.amadeus = "NOT_CONFIGURED (will use RPA fallback)";
  }

  // 4. 測試 Playwright / Chromium
  try {
    const result = await testBrowserLaunch();
    report.browser = result.success
      ? `ok (${result.version})`
      : `FAIL: ${result.error}`;
  } catch (e) {
    report.browser = `FAIL: ${e.message}`;
  }

  // 5. 選填模組狀態
  report.modules = {
    googleFlights: googleFlightsService.isAvailable() ? "enabled ✅" : "disabled ❌ (no RAPIDAPI_KEY)",
    weather: weatherService.isAvailable() ? "enabled" : "disabled (no CWA_API_KEY)",
    news: newsService.isAvailable() ? "enabled" : "disabled (no NEWS_API_KEY)",
    calendar: calendarService.isAvailable() ? "enabled" : "disabled (no Google Calendar config)",
    briefing: briefingService.isAvailable() ? "enabled" : "disabled (no BRIEFING_RECIPIENTS)",
  };

  const allOk = !JSON.stringify(report).includes("FAIL") && !JSON.stringify(report).includes("MISSING");
  res.status(allOk ? 200 : 500).json(report);
});

// ========== 行事曆診斷 ==========
app.get("/debug/calendar", async (req, res) => {
  const info = {
    GOOGLE_SERVICE_ACCOUNT_KEY: process.env.GOOGLE_SERVICE_ACCOUNT_KEY
      ? `set (${process.env.GOOGLE_SERVICE_ACCOUNT_KEY.length} chars, starts: ${process.env.GOOGLE_SERVICE_ACCOUNT_KEY.slice(0, 20)}...)`
      : "NOT SET",
    GOOGLE_CALENDAR_ID: process.env.GOOGLE_CALENDAR_ID || "NOT SET",
    isAvailable: calendarService.isAvailable(),
  };

  // 嘗試解析 JSON（Railway 可能把 \n 變成真實換行）
  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    try {
      let raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = JSON.parse(raw.replace(/\n/g, "\\n"));
        info.fixedNewlines = true;
      }
      info.jsonParse = "OK";
      info.client_email = parsed.client_email || "missing";
      info.project_id = parsed.project_id || "missing";
    } catch (e) {
      info.jsonParse = `FAIL: ${e.message}`;
    }
  }

  // 嘗試查詢
  if (calendarService.isAvailable()) {
    try {
      const result = await calendarService.getEvents(null, new Date().toISOString().slice(0, 10));
      info.apiTest = "OK";
      info.apiResult = result.text?.slice(0, 100);
    } catch (e) {
      info.apiTest = `FAIL: ${e.message}`;
    }
  }

  res.json(info);
});

// ========== 搜尋測試端點 ==========
app.get("/debug/search", async (req, res) => {
  const query = req.query.q || "台積電股價";
  const { webSearchService } = require("./services");
  try {
    const result = await webSearchService.searchWeb(query, 3);
    res.json({ query, success: true, textLength: result.text?.length, text: result.text });
  } catch (e) {
    res.json({ query, success: false, error: e.message });
  }
});

// ========== Google Flights 測試端點 ==========
app.get("/debug/flights", async (req, res) => {
  if (!googleFlightsService.isAvailable()) {
    return res.json({ success: false, error: "RAPIDAPI_KEY 未設定" });
  }
  const origin = req.query.from || "TPE";
  const destination = req.query.to || "NRT";
  const date = req.query.date || new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  try {
    const result = await googleFlightsService.searchFlights({ origin, destination, departDate: date });
    res.json({
      success: true,
      query: { origin, destination, date },
      flightsCount: result.flights?.length || 0,
      text: result.text?.slice(0, 500),
      firstFlight: result.flights?.[0] ? {
        airline: result.flights[0].airline,
        flightNumber: result.flights[0].flightNumber,
        price: result.flights[0].price,
        stops: result.flights[0].stops,
      } : null,
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ========== LINE Webhook（必須放在 express.json() 之前！）==========
// LINE SDK 的 lineMiddleware 需要讀取 raw body 做簽名驗證
// 如果 express.json() 先跑，會把 raw body 消費掉 → 簽名驗證失敗 → 401
app.post("/webhook", lineMiddleware, async (req, res) => {
  try {
    const events = req.body.events;
    if (!events || events.length === 0) return res.json({ status: "ok" });
    logger.info(`[Webhook] 收到 ${events.length} 個事件`);
    res.json({ status: "ok" });
    // 非同步處理（不阻塞 LINE 回應）
    handleWebhookEvents(events).catch((err) => {
      logger.error("[Webhook] 非同步處理失敗", { error: err.message, stack: err.stack });
    });
  } catch (error) {
    logger.error("[Webhook] 錯誤", { error: error.message, stack: error.stack });
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  }
});

// ========== LIFF 小程式（靜態檔案）+ 航班 API ==========
// express.json() 放在 webhook 之後，避免影響 LINE 簽名驗證
app.use("/api", express.json());
app.use("/api/flights", flightApi);
app.use(express.static(path.join(__dirname, "..", "public")));

app.use((err, req, res, next) => {
  if (err.message?.includes("signature")) {
    return res.status(401).json({ error: "Invalid signature" });
  }
  logger.error("Express 錯誤", { error: err.message });
  res.status(500).json({ error: "Internal server error" });
});

// ========== 啟動 ==========
app.listen(config.server.port, () => {
  console.log("\n" + "=".repeat(55));
  console.log("  LINE 全能家庭 AI 管家 v6 已啟動");
  console.log("=".repeat(55));
  console.log(`  Server:   http://localhost:${config.server.port}`);
  console.log(`  Webhook:  /webhook`);
  console.log(`  Health:   /health`);
  console.log(`  LIFF:     /liff/`);
  console.log(`  API:      /api/flights/search`);
  const primary = config.gemini.apiKey ? `Gemini ${config.gemini.model}` : "未設定";
  const fallback = config.anthropic.apiKey ? `Anthropic ${config.anthropic.model}` : "未設定";
  console.log(`  AI 主要:  ${primary}`);
  console.log(`  AI 備援:  ${fallback}`);
  console.log(`  Google Flights: ${googleFlightsService.isAvailable() ? "✅ RapidAPI 已設定" : "❌ 未設定 RAPIDAPI_KEY"}`);
  console.log(`  Amadeus:  ${amadeusClient.isAvailable() ? "✅ 已設定（備援）" : "❌ 未設定"}`);
  console.log(`  Browser:  Headless=${config.browser.headless}, MaxPages=${config.browser.maxPages}`);
  console.log("  " + "-".repeat(53));
  console.log(`  天氣:     ${weatherService.isAvailable() ? "✅ CWA 已設定" : "⬜ 未設定"}`);
  console.log(`  新聞:     ${newsService.isAvailable() ? "✅ NewsAPI 已設定" : "⬜ 未設定"}`);
  console.log(`  行事曆:   ${calendarService.isAvailable() ? "✅ Google Calendar 已設定" : "⬜ 未設定"}`);
  console.log(`  晨報:     ${briefingService.isAvailable() ? "✅ " + config.briefing.time + " → " + config.briefing.recipients.length + " 位" : "⬜ 未設定"}`);
  console.log("=".repeat(55));
  console.log("  支援航空: CI / BR / JX / EK / TK / CX / SQ\n");

  // 啟動晨報排程
  if (briefingService.isAvailable()) {
    briefingService.initCron();
  }
});

// 優雅關閉
process.on("SIGINT", async () => {
  logger.info("收到 SIGINT，正在關閉...");
  await shutdown();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  logger.info("收到 SIGTERM，正在關閉...");
  await shutdown();
  process.exit(0);
});
