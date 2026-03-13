// =============================================
// 統一排程服務 — Per-User 通知排程
//
// 每分鐘掃描 DB 中的用戶設定：
// - 晨報（BriefingConfig）
// - 通勤路況（CommuteRoute）
// 每 5 分鐘：
// - 行事曆提醒（有綁 GoogleAuth 的用戶）
//
// 向下相容：若無 DB，回退到各 service 的 initCron()
// =============================================

const cron = require("node-cron");
const logger = require("../utils/logger");
const { prisma, isDbAvailable } = require("../db/prisma");
const { lineClient } = require("../line/lineClient");
const { config } = require("../config");
const calendarService = require("./calendarService");
const weatherService = require("./weatherService");
const newsService = require("./newsService");
const { fetchDirections, parseRoutes, trafficStatus, buildMapsLink, formatCommuteMessage } = require("./commuteService");

// 已提醒事件的集合（防重複）key: userId:eventId
const remindedSet = new Set();

/**
 * 初始化 per-user 排程器（需要 DB）
 */
function initScheduler() {
  if (!isDbAvailable()) {
    logger.info("[Scheduler] DB 未設定，跳過 per-user 排程（使用舊版各 service cron）");
    return;
  }

  // 每分鐘：檢查晨報 + 通勤
  cron.schedule("* * * * *", async () => {
    try {
      await checkBriefings();
    } catch (e) {
      logger.error(`[Scheduler] 晨報檢查失敗: ${e.message}`);
    }
    try {
      await checkCommuteNotifications();
    } catch (e) {
      logger.error(`[Scheduler] 通勤檢查失敗: ${e.message}`);
    }
  }, {
    timezone: config.briefing?.timezone || "Asia/Taipei",
  });

  // 每 5 分鐘：行事曆提醒
  cron.schedule("*/5 * * * *", async () => {
    try {
      await checkEventReminders();
    } catch (e) {
      logger.error(`[Scheduler] 行事曆提醒失敗: ${e.message}`);
    }
  }, {
    timezone: config.briefing?.timezone || "Asia/Taipei",
  });

  // 每天 00:00 清空已提醒集合
  cron.schedule("0 0 * * *", () => {
    const count = remindedSet.size;
    remindedSet.clear();
    if (count > 0) logger.info(`[Scheduler] 每日重置：清空 ${count} 筆已提醒記錄`);
  }, {
    timezone: config.briefing?.timezone || "Asia/Taipei",
  });

  logger.info("[Scheduler] Per-user 排程器已啟動");
}

// ========== 晨報 ==========

const CATEGORY_NAMES = {
  general: "綜合", business: "財經", technology: "科技",
  sports: "體育", entertainment: "娛樂", health: "健康", science: "科學",
};

async function checkBriefings() {
  if (!prisma) return;

  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  // 找出設定了此時間晨報的活躍用戶
  const configs = await prisma.briefingConfig.findMany({
    where: { enabled: true, time: currentTime },
    include: { user: { include: { settings: true, googleAuth: true } } },
  });

  if (configs.length === 0) return;

  logger.info(`[Scheduler] 晨報 ${currentTime}：${configs.length} 位用戶`);

  for (const bc of configs) {
    if (bc.user.status !== "ACTIVE") continue;
    try {
      await triggerBriefingForUser(bc.user, bc);
    } catch (e) {
      logger.error(`[Scheduler] 晨報失敗 user=${bc.user.lineUserId.slice(-6)}: ${e.message}`);
    }
  }
}

async function triggerBriefingForUser(user, briefingConfig) {
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10);
  const days = ["日", "一", "二", "三", "四", "五", "六"];
  const dayLabel = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, "0")}/${String(today.getDate()).padStart(2, "0")} (${days[today.getDay()]})`;

  // 解析用戶的晨報設定
  const cities = (briefingConfig.cities || "臺北市").split(",").map(s => s.trim()).filter(Boolean);
  const newsSections = parseBriefingNews(briefingConfig.newsSections);

  // 並行取得資料
  const weatherPromises = cities.map((city) =>
    weatherService.isAvailable()
      ? weatherService.getWeather(city, 1).catch(() => null)
      : Promise.resolve(null)
  );

  const hasCalendar = !!user.googleAuth;
  const eventsPromise = hasCalendar
    ? calendarService.getEvents(null, dateStr, dateStr, user.id).catch(() => null)
    : Promise.resolve(null);

  const newsPromises = newsSections.map((section) =>
    newsService.isAvailable()
      ? newsService.getNews(section.category, section.count, section.region).catch(() => null)
      : Promise.resolve(null)
  );

  const [weatherResults, eventsResult, ...newsResults] = await Promise.all([
    Promise.all(weatherPromises),
    eventsPromise,
    ...newsPromises,
  ]);

  // 組合晨報
  let b = `☀️ 早安！${dayLabel}\n`;

  // 天氣
  if (weatherResults.some(w => w)) {
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
  }

  // 行程
  if (hasCalendar) {
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
  if (newsResults.some(n => n)) {
    b += "\n📰 新聞\n";
    for (let i = 0; i < newsSections.length; i++) {
      const section = newsSections[i];
      const news = newsResults[i];
      const regionLabel = section.region === "world" ? "🌍" : "🇹🇼";
      const catLabel = CATEGORY_NAMES[section.category] || section.category;
      b += `${regionLabel} ${catLabel}：\n`;
      if (news && news.articles && news.articles.length > 0) {
        news.articles.forEach((article, idx) => {
          b += `${idx + 1}. ${article.title}\n`;
          if (article.source) b += `   📍${article.source}\n`;
        });
      } else {
        b += "暫無新聞\n";
      }
    }
  }

  b += "\n祝你有美好的一天！🎉";

  // 推播
  await lineClient.pushMessage({
    to: user.lineUserId,
    messages: [{ type: "text", text: b }],
  });

  logger.info(`[Scheduler] 晨報已推播 user=${user.lineUserId.slice(-6)}`);
}

function parseBriefingNews(str) {
  if (!str) return [{ region: "tw", category: "general", count: 5 }];
  return str.split(",").map((s) => {
    const [region, category, count] = s.trim().split(":");
    return { region: region || "tw", category: category || "general", count: parseInt(count) || 3 };
  }).filter((s) => s.region && s.category);
}

// ========== 通勤路況 ==========

async function checkCommuteNotifications() {
  if (!prisma || !config.commute?.googleMapsApiKey) return;

  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const dayOfWeek = now.getDay(); // 0=Sun, 6=Sat
  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;

  // 找出設定了此時間通勤路線的活躍用戶
  const routes = await prisma.commuteRoute.findMany({
    where: { notifyTime: currentTime },
    include: { user: true },
  });

  if (routes.length === 0) return;

  // 按用戶分組
  const userRoutes = {};
  for (const route of routes) {
    if (route.user.status !== "ACTIVE") continue;
    if (route.weekdayOnly && !isWeekday) continue;
    if (!userRoutes[route.userId]) {
      userRoutes[route.userId] = { user: route.user, routes: [] };
    }
    userRoutes[route.userId].routes.push(route);
  }

  for (const [, { user, routes: userRouteList }] of Object.entries(userRoutes)) {
    try {
      await triggerCommuteForUser(user, userRouteList);
    } catch (e) {
      logger.error(`[Scheduler] 通勤推播失敗 user=${user.lineUserId.slice(-6)}: ${e.message}`);
    }
  }
}

async function triggerCommuteForUser(user, routes) {
  const now = new Date();
  const days = ["日", "一", "二", "三", "四", "五", "六"];
  const dateLabel = `${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")} (${days[now.getDay()]})`;
  const timeLabel = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  let text = `🚗 通勤路況 ${dateLabel} ${timeLabel}\n`;

  for (const route of routes) {
    try {
      const data = await fetchDirections(route.origin, route.destination);
      const parsed = parseRoutes(data);
      text += `\n${formatCommuteMessage(route.name, parsed)}`;
      text += `\n🗺️ 導航：${buildMapsLink(route.origin, route.destination)}\n`;
    } catch (e) {
      text += `\n📍 ${route.name}\n  ⚠️ 查詢失敗：${e.message}\n`;
    }
  }

  await lineClient.pushMessage({
    to: user.lineUserId,
    messages: [{ type: "text", text }],
  });

  logger.info(`[Scheduler] 通勤已推播 user=${user.lineUserId.slice(-6)} (${routes.length} 條路線)`);
}

// ========== 行事曆提醒 ==========

async function checkEventReminders() {
  if (!prisma) return;

  // 找出所有有綁定 Google 行事曆的活躍用戶
  const users = await prisma.user.findMany({
    where: {
      status: "ACTIVE",
      googleAuth: { isNot: null },
    },
    include: {
      settings: true,
      googleAuth: true,
    },
  });

  if (users.length === 0) return;

  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  for (const user of users) {
    try {
      await checkEventsForUser(user, now, today);
    } catch (e) {
      logger.error(`[Scheduler] 行事曆提醒失敗 user=${user.lineUserId.slice(-6)}: ${e.message}`);
    }
  }
}

async function checkEventsForUser(user, now, today) {
  const reminderMinutes = user.settings?.eventReminderMin || config.eventReminder?.minutes || 120;

  const events = await calendarService.getRawEvents(today, null, user.id);
  if (!events || events.length === 0) return;

  const upcomingEvents = events.filter((event) => {
    if (event.allDay) return false;
    const key = `${user.id}:${event.id}`;
    if (remindedSet.has(key)) return false;

    const eventStart = new Date(event.start);
    const minutesUntilStart = (eventStart - now) / 60000;
    return minutesUntilStart > 0 && minutesUntilStart <= reminderMinutes;
  });

  if (upcomingEvents.length === 0) return;

  const origin = user.settings?.eventReminderOrigin || null;

  for (const event of upcomingEvents) {
    try {
      const text = await buildReminderMessage(event, now, origin);
      await lineClient.pushMessage({
        to: user.lineUserId,
        messages: [{ type: "text", text }],
      });
      remindedSet.add(`${user.id}:${event.id}`);
      logger.info(`[Scheduler] 行程提醒 user=${user.lineUserId.slice(-6)}: ${event.summary}`);
    } catch (e) {
      logger.error(`[Scheduler] 推播提醒失敗: ${e.message}`);
    }
  }
}

async function buildReminderMessage(event, now, origin) {
  const eventStart = new Date(event.start);
  const minutesUntilStart = Math.round((eventStart - now) / 60000);
  const timeUntilText = formatTimeUntil(minutesUntilStart);
  const calLabel = event.calendarLabel ? ` [${event.calendarLabel}]` : "";

  let text = `📅 行程提醒\n\n`;
  text += `🔔 ${event.startTime} ${event.summary}${calLabel}\n`;

  if (event.location) {
    text += `📍 ${event.location}\n`;

    if (origin && config.commute?.googleMapsApiKey) {
      try {
        const data = await fetchDirections(origin, event.location);
        const routes = parseRoutes(data);
        if (routes.length > 0) {
          const best = routes[0];
          const status = trafficStatus(best.ratio);
          text += `\n🚗 路況：\n`;
          text += `  ⏱️ 預估 ${best.durationInTrafficText}（平時 ${best.durationText}）\n`;
          text += `  📏 ${best.distance}\n`;
          text += `  ${status.emoji} ${status.label}\n`;

          const travelMinutes = Math.ceil(best.durationInTraffic / 60);
          const suggestedDepartMs = eventStart.getTime() - (travelMinutes + 10) * 60000;
          const suggestedDepart = new Date(suggestedDepartMs);
          const departStr = `${String(suggestedDepart.getHours()).padStart(2, "0")}:${String(suggestedDepart.getMinutes()).padStart(2, "0")}`;
          text += `\n⏰ 建議 ${departStr} 前出發`;
          text += `\n\n🗺️ 導航：${buildMapsLink(origin, event.location)}`;
        }
      } catch (e) {
        text += `\n⏰ ${timeUntilText}後開始`;
        text += `\n\n🗺️ 導航：${buildMapsLink(origin, event.location)}`;
      }
    } else {
      text += `\n⏰ ${timeUntilText}後開始`;
      if (origin) {
        text += `\n\n🗺️ 導航：${buildMapsLink(origin, event.location)}`;
      }
    }
  } else {
    text += `⏰ ${timeUntilText}後開始`;
  }

  return text;
}

function formatTimeUntil(minutes) {
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hours} 小時 ${mins} 分鐘` : `${hours} 小時`;
  }
  return `${minutes} 分鐘`;
}

module.exports = { initScheduler, triggerBriefingForUser };
