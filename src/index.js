const express = require("express");
const { config, validateConfig } = require("./config");
const { lineMiddleware } = require("./line/lineClient");
const { handleWebhookEvents } = require("./line/lineHandler");
const { shutdown } = require("./scraper/browserManager");
const logger = require("./utils/logger");

// 檢查設定
validateConfig();

const app = express();

// 健康檢查
app.get("/", (req, res) => {
  res.json({ status: "ok", name: "LINE Bot 智能機票助手 (RPA版) ✈️" });
});

// LINE Webhook
app.post("/webhook", lineMiddleware, async (req, res) => {
  try {
    const events = req.body.events;
    if (!events || events.length === 0) return res.json({ status: "ok" });
    logger.info(`收到 ${events.length} 個 LINE 事件`);
    res.json({ status: "ok" });
    await handleWebhookEvents(events);
  } catch (error) {
    logger.error("Webhook 錯誤", { error: error.message });
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  }
});

app.use((err, req, res, next) => {
  if (err.message?.includes("signature")) {
    return res.status(401).json({ error: "Invalid signature" });
  }
  logger.error("錯誤", { error: err.message });
  res.status(500).json({ error: "Internal server error" });
});

// 啟動
app.listen(config.server.port, () => {
  console.log("\n" + "=".repeat(55));
  console.log("  ✈️  LINE Bot 智能機票助手（RPA 版）已啟動！");
  console.log("=".repeat(55));
  console.log(`  🌐 http://localhost:${config.server.port}`);
  console.log(`  📡 Webhook: http://localhost:${config.server.port}/webhook`);
  console.log(`  🤖 AI: ${config.anthropic.model}`);
  console.log(`  🖥️  瀏覽器: Headless=${config.browser.headless}`);
  console.log("=".repeat(55));
  console.log("\n  支援航空公司：華航(CI) / 長榮(BR) / 星宇(JX)");
  console.log("\n  💡 下一步：");
  console.log("  1. npx playwright install chromium");
  console.log("  2. ngrok http 3000");
  console.log("  3. 設定 LINE Webhook URL");
  console.log("  4. 在 LINE 上跟 Bot 說話！\n");
});

// 優雅關閉 - 確保瀏覽器正確關閉
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
