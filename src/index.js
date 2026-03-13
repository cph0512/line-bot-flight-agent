const express = require("express");
const path = require("path");
const { config, validateConfig } = require("./config");
const { lineMiddleware, lineClient } = require("./line/lineClient");
const { handleWebhookEvents } = require("./line/lineHandler");
const { shutdown, testBrowserLaunch } = require("./scraper/browserManager");
const amadeusClient = require("./scraper/amadeusClient");
const flightApi = require("./api/flightApi");
const nannyApi = require("./api/nannyApi");
const userApi = require("./api/userApi");
const adminApi = require("./api/adminApi");
const { weatherService, newsService, calendarService, briefingService, googleFlightsService, commuteService, eventReminderService, nannyService } = require("./services");
const logger = require("./utils/logger");
const { prisma, isDbAvailable, testConnection, disconnect } = require("./db/prisma");
const googleOAuth = require("./auth/googleOAuth");

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
    commute: commuteService.isAvailable() ? "enabled" : "disabled",
    eventReminder: eventReminderService.isAvailable() ? `enabled (${config.eventReminder?.minutes || 120}min)` : "disabled",
    nanny: nannyService.isAvailable() ? `enabled (${nannyService.getAllNannies().length} nannies)` : "disabled",
    database: isDbAvailable() ? "connected" : "not configured",
    googleOAuth: googleOAuth.isAvailable() ? "enabled" : "disabled",
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
    commute: commuteService.isAvailable() ? "enabled" : "disabled (no GOOGLE_MAPS_API_KEY or COMMUTE_ROUTES)",
    eventReminder: eventReminderService.isAvailable() ? `enabled (${config.eventReminder?.minutes || 120}min before)` : "disabled (no calendar)",
    nanny: nannyService.isAvailable() ? `enabled (${nannyService.getAllNannies().length} nannies)` : "disabled (no config)",
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

// ========== 通勤路況測試端點 ==========
app.get("/debug/commute", async (req, res) => {
  if (!commuteService.isAvailable()) {
    return res.json({ success: false, error: "未設定 GOOGLE_MAPS_API_KEY 或 COMMUTE_ROUTES", config: { hasApiKey: !!config.commute?.googleMapsApiKey, routes: config.commute?.routes?.length || 0 } });
  }
  try {
    const result = await commuteService.getCommuteInfo(req.query.route);
    res.json({ success: true, text: result.text });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ========== 行事曆提醒測試端點 ==========
app.get("/debug/reminder", async (req, res) => {
  if (!eventReminderService.isAvailable()) {
    return res.json({ success: false, error: "行事曆未設定" });
  }
  try {
    await eventReminderService.checkUpcomingEvents();
    res.json({ success: true, message: "已執行事件掃描，若有即將開始的事件會推播提醒" });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ========== 保母薪資測試端點 ==========
app.get("/debug/nanny", async (req, res) => {
  if (!nannyService.isAvailable()) {
    return res.json({ success: false, error: "保母設定檔不存在" });
  }
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const result = await nannyService.calculateAllSalaries(month);
    res.json({ success: true, month, text: result.text, records: result.records });
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

// ========== Google OAuth 2.0 行事曆綁定 ==========
app.get("/auth/google/start", (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).send("缺少 token 參數");

  if (!googleOAuth.isAvailable()) {
    return res.status(503).send("Google OAuth 未設定，請聯繫管理員");
  }

  // 驗證 JWT 取得 lineUserId
  const { verifyAdminToken } = require("./auth/adminAuth");
  const payload = verifyAdminToken(token);
  if (!payload) return res.status(401).send("Token 無效或已過期，請重新從 LINE 取得連結");

  try {
    const url = googleOAuth.generateAuthUrl(payload.lineUserId);

    // 偵測 LINE 內建瀏覽器（WebView）— Google 封鎖 WebView OAuth
    const ua = req.headers["user-agent"] || "";
    if (/Line\//i.test(ua)) {
      const currentUrl = `${config.app.url}/auth/google/start?token=${token}`;
      return res.send(`<!DOCTYPE html><html lang="zh-TW"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>綁定 Google 行事曆</title>
<style>body{font-family:-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;padding:20px}.card{background:#1e293b;border-radius:16px;padding:32px 24px;max-width:360px;text-align:center}h2{font-size:20px;margin-bottom:12px;color:#f59e0b}p{font-size:14px;color:#94a3b8;line-height:1.6;margin-bottom:20px}.btn{display:block;background:#f59e0b;color:#0f172a;padding:14px 24px;border-radius:10px;font-size:16px;font-weight:600;text-decoration:none;margin-bottom:16px}.hint{font-size:12px;color:#64748b;line-height:1.5}.copy-area{background:#0f172a;border-radius:8px;padding:10px;margin:12px 0;word-break:break-all;font-size:11px;color:#94a3b8}.copy-btn{background:#334155;color:#e2e8f0;border:none;padding:8px 16px;border-radius:6px;font-size:12px;cursor:pointer;margin-top:8px}</style></head>
<body><div class="card"><h2>綁定 Google 行事曆</h2><p>Google 要求在外部瀏覽器中完成授權</p>
<a class="btn" href="${currentUrl}" target="_blank">在瀏覽器中開啟</a>
<div class="hint">如果按鈕無效，請點右下角 <strong>⋮</strong> 選單<br>→「<strong>在預設瀏覽器中開啟</strong>」</div>
<div class="copy-area" id="u">${currentUrl}</div>
<button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('u').textContent).then(()=>this.textContent='已複製！')">複製連結</button>
</div></body></html>`);
    }

    res.redirect(url);
  } catch (e) {
    logger.error("[OAuth] 產生授權 URL 失敗", { error: e.message });
    res.status(500).send("OAuth 錯誤：" + e.message);
  }
});

app.get("/auth/google/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    return res.send(`<html><body><h2>授權已取消</h2><p>${error}</p><p>你可以關閉此頁面</p></body></html>`);
  }
  if (!code || !state) {
    return res.status(400).send("缺少必要參數");
  }

  try {
    const { tokens, lineUserId, calendarId, email } = await googleOAuth.exchangeCode(code, state);
    await googleOAuth.saveTokens(lineUserId, tokens, calendarId, email);

    // 推播通知用戶綁定成功
    try {
      await lineClient.pushMessage(lineUserId, {
        type: "text",
        text: `✅ Google 行事曆已綁定成功！\n\n📧 帳號：${email || calendarId}\n\n現在你可以直接問我行事曆相關問題，例如：\n• 「今天有什麼行程？」\n• 「幫我新增明天下午 3 點開會」\n• 「下週行程」`,
      });
    } catch (pushErr) {
      logger.warn("[OAuth] 推播綁定成功通知失敗", { error: pushErr.message });
    }

    res.send(`<html><body style="text-align:center;font-family:sans-serif;padding:40px">
      <h2>✅ 行事曆綁定成功！</h2>
      <p>帳號：${email || calendarId}</p>
      <p>你可以回到 LINE 開始使用行事曆功能</p>
      <p style="color:#999;margin-top:20px">此頁面可以關閉</p>
    </body></html>`);
  } catch (e) {
    logger.error("[OAuth] Callback 處理失敗", { error: e.message });
    res.status(500).send(`<html><body style="text-align:center;font-family:sans-serif;padding:40px">
      <h2>❌ 綁定失敗</h2>
      <p>${e.message}</p>
      <p>請回到 LINE 重新嘗試</p>
    </body></html>`);
  }
});

// ========== LIFF 小程式（靜態檔案）+ 航班 API ==========
// express.json() 放在 webhook 之後，避免影響 LINE 簽名驗證
app.use("/api", express.json());
app.use("/api/flights", flightApi);
app.use("/api/nanny", nannyApi);
app.use("/api/user", userApi);
app.use("/api/admin", adminApi);
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
  console.log(`  通勤路況: ${commuteService.isAvailable() ? "✅ " + config.commute.time + " (" + (config.commute.weekdayOnly ? "平日" : "每日") + ") " + config.commute.routes.length + " 路線" : "⬜ 未設定"}`);
  console.log(`  行程提醒: ${eventReminderService.isAvailable() ? "✅ 每 5 分鐘掃描，提前 " + (config.eventReminder?.minutes || 120) + " 分鐘提醒" : "⬜ 未設定"}`);
  console.log(`  保母薪資: ${nannyService.isAvailable() ? "✅ " + nannyService.getAllNannies().length + " 位保母" : "⬜ 未設定"}`);
  console.log(`  後台管理: ${config.nanny?.adminToken ? "✅ /admin" : "⬜ 未設定 ADMIN_TOKEN"}`);
  console.log(`  資料庫:   ${isDbAvailable() ? "✅ PostgreSQL 已連線" : "⬜ 未設定 DATABASE_URL"}`);
  console.log(`  OAuth:    ${googleOAuth.isAvailable() ? "✅ Google OAuth 已設定" : "⬜ 未設定"}`);
  console.log("=".repeat(55));
  console.log("  支援航空: CI / BR / JX / EK / TK / CX / SQ\n");

  // DB 連線測試
  if (isDbAvailable()) {
    testConnection().then((result) => {
      if (result.success) {
        console.log("[DB] PostgreSQL 連線成功");
      } else {
        console.error("[DB] PostgreSQL 連線失敗:", result.error);
      }
    });
  }

  // 啟動晨報排程
  if (briefingService.isAvailable()) {
    briefingService.initCron();
  }
  // 啟動通勤路況排程
  if (commuteService.isAvailable()) {
    commuteService.initCron();
  }
  // 啟動行事曆提醒排程
  if (eventReminderService.isAvailable()) {
    eventReminderService.initCron();
  }

  // 啟動 per-user 排程器（DB-based）
  const { initScheduler } = require("./services/schedulerService");
  initScheduler();
});

// 優雅關閉
async function gracefulShutdown(signal) {
  logger.info(`收到 ${signal}，正在關閉...`);
  await shutdown();
  await disconnect();
  process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
