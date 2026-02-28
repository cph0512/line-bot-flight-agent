// =============================================
// 每日晨報服務
//
// 使用 node-cron 排程，每天指定時間推播
// 內容：天氣 + 今日行程 + 新聞摘要
// =============================================

const cron = require("node-cron");
const logger = require("../utils/logger");
const { config } = require("../config");
const { lineClient } = require("../line/lineClient");
const weatherService = require("./weatherService");
const newsService = require("./newsService");
const calendarService = require("./calendarService");

function isAvailable() {
  return config.briefing?.recipients?.length > 0;
}

/**
 * 初始化 cron 排程
 */
function initCron() {
  if (!isAvailable()) {
    logger.info("[Briefing] 未設定接收者，跳過排程初始化");
    return;
  }

  const time = config.briefing.time || "07:00";
  const [hour, minute] = time.split(":");
  const cronExpr = `${parseInt(minute)} ${parseInt(hour)} * * *`;

  cron.schedule(cronExpr, async () => {
    logger.info("[Briefing] === 開始每日晨報 ===");
    try {
      await triggerBriefing();
    } catch (error) {
      logger.error(`[Briefing] 晨報失敗: ${error.message}`);
    }
  }, {
    timezone: config.briefing.timezone || "Asia/Taipei",
  });

  logger.info(`[Briefing] 每日晨報已排程: ${time} (${config.briefing.timezone})`);
  logger.info(`[Briefing] 接收者: ${config.briefing.recipients.length} 人`);
}

/**
 * 觸發晨報（手動或排程）
 */
async function triggerBriefing() {
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10);
  const days = ["日", "一", "二", "三", "四", "五", "六"];
  const dayLabel = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, "0")}/${String(today.getDate()).padStart(2, "0")} (${days[today.getDay()]})`;

  logger.info(`[Briefing] 產生晨報 ${dateStr}`);

  // 並行取得所有資料（任一失敗不影響其他）
  const [weatherResult, eventsResult, newsResult] = await Promise.allSettled([
    weatherService.isAvailable()
      ? weatherService.getWeather(config.briefing.defaultCity || "台北", 1)
      : Promise.resolve(null),
    calendarService.isAvailable()
      ? calendarService.getEvents(null, dateStr, dateStr)
      : Promise.resolve(null),
    newsService.isAvailable()
      ? newsService.getNews("general", 5)
      : Promise.resolve(null),
  ]);

  // 組合晨報內容
  let briefing = `☀️ 早安！今天是 ${dayLabel}\n`;
  briefing += "─".repeat(20) + "\n";

  // 天氣
  const weather = weatherResult.status === "fulfilled" && weatherResult.value;
  if (weather && weather.text) {
    briefing += "\n🌤️ 天氣\n";
    // 提取關鍵資訊（簡化版）
    const weatherLines = weather.text.split("\n").filter((l) => l.trim() && !l.startsWith("==="));
    briefing += weatherLines.slice(0, 8).join("\n") + "\n";
  }

  // 行程
  const events = eventsResult.status === "fulfilled" && eventsResult.value;
  if (events && events.text) {
    briefing += "\n📅 今日行程\n";
    const eventLines = events.text.split("\n").filter(
      (l) => l.trim() && !l.startsWith("===") && !l.startsWith("共") && !l.includes("eventId:")
    );
    if (eventLines.length > 0) {
      briefing += eventLines.join("\n") + "\n";
    } else {
      briefing += "今天沒有行程，好好放鬆！\n";
    }
  }

  // 新聞
  const news = newsResult.status === "fulfilled" && newsResult.value;
  if (news && news.text) {
    briefing += "\n📰 今日新聞\n";
    const newsLines = news.text.split("\n").filter((l) => l.trim() && !l.startsWith("==="));
    briefing += newsLines.slice(0, 15).join("\n") + "\n";
  }

  briefing += "\n─".repeat(20);
  briefing += "\n祝你有美好的一天！ 🎉";

  // 推播給所有接收者
  const recipients = config.briefing.recipients || [];
  let sentCount = 0;

  for (const userId of recipients) {
    try {
      await lineClient.pushMessage({
        to: userId.trim(),
        messages: [{ type: "text", text: briefing }],
      });
      sentCount++;
      logger.info(`[Briefing] 已推播給 ${userId.slice(-6)}`);
    } catch (error) {
      logger.error(`[Briefing] 推播失敗 ${userId.slice(-6)}: ${error.message}`);
    }
  }

  logger.info(`[Briefing] 晨報完成: ${sentCount}/${recipients.length} 人`);

  return { text: `早報已發送給 ${sentCount} 位接收者。\n\n${briefing}` };
}

module.exports = { isAvailable, initCron, triggerBriefing };
