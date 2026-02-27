const express = require("express");
const { config, validateConfig } = require("./config");
const { lineMiddleware } = require("./line/lineClient");
const { handleWebhookEvents } = require("./line/lineHandler");
const { shutdown, testBrowserLaunch } = require("./scraper/browserManager");
const logger = require("./utils/logger");

// 檢查設定
validateConfig();

const app = express();

// ========== 健康檢查 + 診斷 ==========
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    name: "LINE Bot 智能機票助手 (RPA版)",
    uptime: Math.round(process.uptime()) + "s",
    memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + "MB",
  });
});

// 完整診斷端點 - 一次檢查所有組件
app.get("/health", async (req, res) => {
  const report = {
    timestamp: new Date().toISOString(),
    server: "ok",
    env: {},
    anthropic: "untested",
    browser: "untested",
  };

  // 1. 環境變數
  report.env.LINE_CHANNEL_ACCESS_TOKEN = config.line.channelAccessToken ? "set" : "MISSING";
  report.env.LINE_CHANNEL_SECRET = config.line.channelSecret ? "set" : "MISSING";
  report.env.ANTHROPIC_API_KEY = config.anthropic.apiKey
    ? `set (${config.anthropic.apiKey.slice(0, 10)}...)`
    : "MISSING";
  report.env.ANTHROPIC_MODEL = config.anthropic.model;
  report.env.BROWSER_HEADLESS = String(config.browser.headless);
  report.env.BROWSER_MAX_PAGES = config.browser.maxPages;

  // 2. 測試 Anthropic API 是否可用
  try {
    const Anthropic = require("@anthropic-ai/sdk").default;
    const client = new Anthropic({ apiKey: config.anthropic.apiKey });
    const testRes = await client.messages.create({
      model: config.anthropic.model,
      max_tokens: 30,
      messages: [{ role: "user", content: "reply OK" }],
    });
    const text = testRes.content?.[0]?.text || "";
    report.anthropic = `ok (response="${text.slice(0, 20)}")`;
  } catch (e) {
    report.anthropic = `FAIL: ${e.message}`;
  }

  // 3. 測試 Playwright / Chromium
  try {
    const result = await testBrowserLaunch();
    report.browser = result.success
      ? `ok (${result.version})`
      : `FAIL: ${result.error}`;
  } catch (e) {
    report.browser = `FAIL: ${e.message}`;
  }

  const allOk = !JSON.stringify(report).includes("FAIL") && !JSON.stringify(report).includes("MISSING");
  res.status(allOk ? 200 : 500).json(report);
});

// ========== LINE Webhook ==========
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
  console.log("  LINE Bot 智能機票助手（RPA 版）已啟動");
  console.log("=".repeat(55));
  console.log(`  Server:   http://localhost:${config.server.port}`);
  console.log(`  Webhook:  /webhook`);
  console.log(`  Health:   /health  <-- 啟動後請先訪問此檢查`);
  console.log(`  AI Model: ${config.anthropic.model}`);
  console.log(`  Browser:  Headless=${config.browser.headless}, MaxPages=${config.browser.maxPages}`);
  console.log("=".repeat(55));
  console.log("  支援航空: CI / BR / JX / EK / TK / CX / SQ\n");
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
