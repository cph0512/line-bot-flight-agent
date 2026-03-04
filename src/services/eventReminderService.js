// =============================================
// 行事曆主動提醒服務
//
// 每 5 分鐘掃描行事曆，事件開始前 N 分鐘推播提醒
// 若事件有地點，附帶即時路況和預估車程
// =============================================

const cron = require("node-cron");
const logger = require("../utils/logger");
const { config } = require("../config");
const { lineClient } = require("../line/lineClient");
const calendarService = require("./calendarService");
const { fetchDirections, parseRoutes, trafficStatus, buildMapsLink } = require("./commuteService");

// 已提醒事件的集合（防重複）
const remindedSet = new Set();

function isAvailable() {
  return calendarService.isAvailable();
}

/**
 * 取得路況起算地址
 */
function getDefaultOrigin() {
  if (config.eventReminder.origin) return config.eventReminder.origin;
  // fallback: COMMUTE_ROUTES 第一條路線的起點
  if (config.commute?.routes?.length > 0) return config.commute.routes[0].origin;
  return null;
}

/**
 * 初始化排程
 */
function initCron() {
  if (!isAvailable()) {
    logger.info("[EventReminder] 行事曆未設定，跳過排程初始化");
    return;
  }

  // 每 5 分鐘掃描
  cron.schedule("*/5 * * * *", async () => {
    try {
      await checkUpcomingEvents();
    } catch (error) {
      logger.error(`[EventReminder] 掃描失敗: ${error.message}`);
    }
  }, {
    timezone: config.briefing?.timezone || "Asia/Taipei",
  });

  // 每天 00:00 清空已提醒集合
  cron.schedule("0 0 * * *", () => {
    const count = remindedSet.size;
    remindedSet.clear();
    if (count > 0) logger.info(`[EventReminder] 每日重置：清空 ${count} 筆已提醒記錄`);
  }, {
    timezone: config.briefing?.timezone || "Asia/Taipei",
  });

  const origin = getDefaultOrigin();
  logger.info(`[EventReminder] 已啟動：每 5 分鐘掃描，提前 ${config.eventReminder.minutes} 分鐘提醒`);
  if (origin) {
    logger.info(`[EventReminder] 路況起點: ${origin}`);
  } else {
    logger.info(`[EventReminder] 未設定路況起點（僅提醒不含路況）`);
  }
}

/**
 * 掃描即將開始的事件
 */
async function checkUpcomingEvents() {
  const today = new Date().toISOString().slice(0, 10);
  const events = await calendarService.getRawEvents(today);

  if (!events || events.length === 0) return;

  const now = new Date();
  const reminderMinutes = config.eventReminder.minutes || 120;

  const upcomingEvents = events.filter((event) => {
    if (event.allDay) return false;
    if (remindedSet.has(event.id)) return false;

    // 計算距離事件開始的分鐘數
    const eventStart = new Date(event.start);
    const minutesUntilStart = (eventStart - now) / 60000;

    // 提醒窗口：0 ~ reminderMinutes 分鐘之間
    return minutesUntilStart > 0 && minutesUntilStart <= reminderMinutes;
  });

  if (upcomingEvents.length === 0) return;

  logger.info(`[EventReminder] 發現 ${upcomingEvents.length} 個即將開始的事件`);

  for (const event of upcomingEvents) {
    try {
      const message = await buildReminderMessage(event, now);
      await sendReminder(message);
      remindedSet.add(event.id);
      logger.info(`[EventReminder] 已提醒: ${event.summary} (${event.startTime})`);
    } catch (error) {
      logger.error(`[EventReminder] 提醒失敗 ${event.summary}: ${error.message}`);
    }
  }
}

/**
 * 組合提醒訊息
 */
async function buildReminderMessage(event, now) {
  const eventStart = new Date(event.start);
  const minutesUntilStart = Math.round((eventStart - now) / 60000);
  const timeUntilText = formatTimeUntil(minutesUntilStart);

  const calLabel = event.calendarLabel ? ` [${event.calendarLabel}]` : "";

  let text = `📅 行程提醒\n\n`;
  text += `🔔 ${event.startTime} ${event.summary}${calLabel}\n`;

  if (event.location) {
    text += `📍 ${event.location}\n`;

    // 查路況
    const origin = getDefaultOrigin();
    if (origin && config.commute?.googleMapsApiKey) {
      try {
        const data = await fetchDirections(origin, event.location);
        const routes = parseRoutes(data);

        if (routes.length > 0) {
          const best = routes[0];
          const status = trafficStatus(best.ratio);

          text += `\n🚗 從${shortenAddress(origin)}出發：\n`;
          text += `  ⏱️ 預估 ${best.durationInTrafficText}（平時 ${best.durationText}）\n`;
          text += `  📏 ${best.distance}\n`;
          text += `  ${status.emoji} ${status.label}\n`;

          // 建議出發時間
          const travelMinutes = Math.ceil(best.durationInTraffic / 60);
          const bufferMinutes = 10; // 預留 10 分鐘緩衝
          const suggestedDepartMs = eventStart.getTime() - (travelMinutes + bufferMinutes) * 60000;
          const suggestedDepart = new Date(suggestedDepartMs);
          const departStr = `${String(suggestedDepart.getHours()).padStart(2, "0")}:${String(suggestedDepart.getMinutes()).padStart(2, "0")}`;
          text += `\n⏰ 建議 ${departStr} 前出發`;
          text += `\n\n🗺️ 導航：${buildMapsLink(origin, event.location)}`;
        }
      } catch (e) {
        logger.warn(`[EventReminder] 路況查詢失敗: ${e.message}`);
        text += `\n⏰ ${timeUntilText}後開始`;
        text += `\n\n🗺️ 導航：${buildMapsLink(origin, event.location)}`;
      }
    } else {
      // 沒有 Google Maps API key，但有地點 → 給導航連結（不含路況）
      const origin2 = getDefaultOrigin();
      text += `\n⏰ ${timeUntilText}後開始`;
      if (origin2) {
        text += `\n\n🗺️ 導航：${buildMapsLink(origin2, event.location)}`;
      }
    }
  } else {
    text += `⏰ ${timeUntilText}後開始`;
  }

  return text;
}

/**
 * 格式化剩餘時間
 */
function formatTimeUntil(minutes) {
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hours} 小時 ${mins} 分鐘` : `${hours} 小時`;
  }
  return `${minutes} 分鐘`;
}

/**
 * 縮短地址（只取主要部分）
 */
function shortenAddress(address) {
  // 如果地址太長，只取前面的區域
  if (address.length > 15) {
    // 嘗試取到「路/街」為止
    const match = address.match(/(.{2,8}(?:路|街|大道|巷))/);
    if (match) return match[1];
    return address.slice(0, 12) + "...";
  }
  return address;
}

/**
 * 推播提醒給所有接收者
 */
async function sendReminder(text) {
  const recipients = config.briefing?.recipients || [];
  if (recipients.length === 0) {
    logger.warn("[EventReminder] 無接收者（BRIEFING_RECIPIENTS 未設定）");
    return;
  }

  for (const userId of recipients) {
    try {
      await lineClient.pushMessage({
        to: userId.trim(),
        messages: [{ type: "text", text }],
      });
    } catch (error) {
      logger.error(`[EventReminder] 推播失敗 ${userId.slice(-6)}: ${error.message}`);
    }
  }
}

/**
 * 手動觸發檢查（debug 用）
 */
async function triggerCheck() {
  return await checkUpcomingEvents();
}

module.exports = { isAvailable, initCron, checkUpcomingEvents, triggerCheck };
