// =============================================
// 每日晨報服務 v3 — 精簡排版
//
// 使用 node-cron 排程，每天指定時間推播
// 支援：多城市天氣 + 今日行程 + 多區域/分類新聞
// =============================================

const cron = require("node-cron");
const logger = require("../utils/logger");
const { config } = require("../config");
const { lineClient } = require("../line/lineClient");
const weatherService = require("./weatherService");
const newsService = require("./newsService");
const calendarService = require("./calendarService");

const CATEGORY_NAMES = {
  general: "綜合", business: "財經", technology: "科技",
  sports: "體育", entertainment: "娛樂", health: "健康", science: "科學",
};

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
  logger.info(`[Briefing] 天氣城市: ${config.briefing.cities.join(", ")}`);
  logger.info(`[Briefing] 新聞區塊: ${config.briefing.newsSections.map(s => `${s.region}:${s.category}:${s.count}`).join(", ")}`);
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

  // === 並行取得所有資料 ===
  const cities = config.briefing.cities;
  const newsSections = config.briefing.newsSections;

  const weatherPromises = cities.map((city) =>
    weatherService.getWeather(city, 1).catch((e) => {
      logger.warn(`[Briefing] ${city} 天氣取得失敗: ${e.message}`);
      return null;
    })
  );

  const eventsPromise = calendarService.isAvailable()
    ? calendarService.getEvents(null, dateStr, dateStr).catch((e) => {
        logger.warn(`[Briefing] 行事曆查詢失敗: ${e.message}`);
        return null;
      })
    : Promise.resolve(null);

  const newsPromises = newsSections.map((section) =>
    newsService.getNews(section.category, section.count, section.region).catch((e) => {
      logger.warn(`[Briefing] ${section.region}:${section.category} 新聞取得失敗: ${e.message}`);
      return null;
    })
  );

  const [weatherResults, eventsResult, ...newsResults] = await Promise.all([
    Promise.all(weatherPromises),
    eventsPromise,
    ...newsPromises,
  ]);

  // === 組合晨報（精簡版）===
  let b = `☀️ 早安！${dayLabel}\n`;

  // 天氣
  b += "\n🌤️ 天氣\n";
  for (let i = 0; i < cities.length; i++) {
    const weather = weatherResults[i];
    if (weather && weather.text) {
      const lines = weather.text.split("\n").filter((l) => l.trim() && !l.startsWith("==="));
      const info = [];
      for (const line of lines.slice(0, 6)) {
        const t = line.trim();
        if (t.includes("溫度") || t.includes("天氣") || t.includes("降雨") || t.includes("°") || t.includes("現在")) {
          info.push(t);
        }
      }
      b += `📍${cities[i]}：${info.join(" | ") || "查詢中"}\n`;
    } else {
      b += `📍${cities[i]}：查詢失敗\n`;
    }
  }

  // 行程（只在有行事曆功能時顯示）
  if (calendarService.isAvailable()) {
    b += "\n📅 行程\n";
    if (eventsResult && eventsResult.text) {
      const eventLines = eventsResult.text.split("\n").filter(
        (l) => l.trim() && !l.startsWith("===") && !l.startsWith("共") && !l.includes("eventId:")
      );
      if (eventLines.length > 0) {
        b += eventLines.join("\n") + "\n";
      } else {
        b += "今天沒有行程 🎉\n";
      }
    } else {
      b += "今天沒有行程 🎉\n";
    }
  }

  // 新聞
  b += "\n📰 新聞\n";
  for (let i = 0; i < newsSections.length; i++) {
    const section = newsSections[i];
    const news = newsResults[i];
    const regionLabel = section.region === "world" ? "🌍" : "🇹🇼";
    const catLabel = CATEGORY_NAMES[section.category] || section.category;

    b += `${regionLabel} ${catLabel}：\n`;

    if (news && news.text) {
      const lines = news.text.split("\n").filter((l) => l.trim() && !l.startsWith("===") && !l.startsWith("共"));
      let count = 0;
      for (const line of lines) {
        const titleMatch = line.match(/^\d+\.\s*(.+)/);
        if (titleMatch) {
          count++;
          b += `${count}. ${titleMatch[1].trim()}\n`;
        }
      }
      if (count === 0) b += "暫無新聞\n";
    } else {
      b += "查詢失敗\n";
    }
  }

  b += "\n祝你有美好的一天！🎉";

  // === 推播 ===
  const recipients = config.briefing.recipients || [];
  let sentCount = 0;

  for (const userId of recipients) {
    try {
      await lineClient.pushMessage({
        to: userId.trim(),
        messages: [{ type: "text", text: b }],
      });
      sentCount++;
      logger.info(`[Briefing] 已推播給 ${userId.slice(-6)}`);
    } catch (error) {
      logger.error(`[Briefing] 推播失敗 ${userId.slice(-6)}: ${error.message}`);
    }
  }

  logger.info(`[Briefing] 晨報完成: ${sentCount}/${recipients.length} 人`);

  return { text: `早報已發送給 ${sentCount} 位接收者。\n\n${b}` };
}

module.exports = { isAvailable, initCron, triggerBriefing };
