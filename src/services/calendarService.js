// =============================================
// Google Calendar 行事曆服務
//
// 使用 Service Account 存取多人日曆
// 設定步驟：
// 1. GCP Console → 建立 Service Account → 下載 JSON 金鑰
// 2. 每個家人的 Google Calendar → 設定 → 分享給 Service Account email
// 3. .env 設定 GOOGLE_SERVICE_ACCOUNT_KEY_FILE + GOOGLE_CALENDAR_ID
// =============================================

const { google } = require("googleapis");
const logger = require("../utils/logger");
const { config } = require("../config");

let authClient = null;

function getAuth() {
  if (authClient) return authClient;

  const keyFile = config.calendar?.keyFile;
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

  if (keyJson) {
    // Railway / 雲端部署：直接從環境變數讀取 JSON 金鑰內容
    try {
      const credentials = JSON.parse(keyJson);
      authClient = new google.auth.GoogleAuth({
        credentials,
        scopes: ["https://www.googleapis.com/auth/calendar"],
      });
      return authClient;
    } catch (e) {
      logger.error(`[Calendar] GOOGLE_SERVICE_ACCOUNT_KEY JSON 解析失敗: ${e.message}`);
      return null;
    }
  }

  if (keyFile) {
    // 本地開發：從檔案路徑讀取
    authClient = new google.auth.GoogleAuth({
      keyFile,
      scopes: ["https://www.googleapis.com/auth/calendar"],
    });
    return authClient;
  }

  return null;
}

function getCalendarClient() {
  const auth = getAuth();
  if (!auth) return null;
  return google.calendar({ version: "v3", auth });
}

function isAvailable() {
  const hasKey = !!(config.calendar?.keyFile || process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  return !!(hasKey && config.calendar?.calendarId);
}

/**
 * 解析行事曆名稱 → calendar ID
 */
function resolveCalendar(calendarName) {
  if (!calendarName || calendarName === "我" || calendarName === "我的" || calendarName === "個人") {
    return config.calendar.calendarId;
  }

  // 搜尋家庭行事曆
  const family = config.calendar.familyCalendars || [];
  const match = family.find(
    (c) => c.name === calendarName || c.name.includes(calendarName) || calendarName.includes(c.name)
  );
  return match?.id || config.calendar.calendarId;
}

/**
 * 查詢行程
 */
async function getEvents(calendarName, startDate, endDate) {
  if (!isAvailable()) {
    return { text: "行事曆功能未啟用（未設定 Google Service Account）。\n請參考開發文件設定 GOOGLE_SERVICE_ACCOUNT_KEY_FILE。" };
  }

  const calendar = getCalendarClient();
  const calId = resolveCalendar(calendarName);

  // 日期預設：今天
  const today = new Date().toISOString().slice(0, 10);
  const start = startDate || today;
  const end = endDate || start;

  const timeMin = new Date(`${start}T00:00:00+08:00`).toISOString();
  const timeMax = new Date(`${end}T23:59:59+08:00`).toISOString();

  logger.info(`[Calendar] 查詢行程 ${calId.slice(0, 20)}... ${start} ~ ${end}`);

  try {
    // 查個人行事曆
    const events = await fetchEvents(calendar, calId, timeMin, timeMax);

    // 如果有查全家
    let familyEvents = [];
    if (!calendarName || calendarName === "全家" || calendarName === "家庭") {
      for (const fc of config.calendar.familyCalendars || []) {
        try {
          const fEvents = await fetchEvents(calendar, fc.id, timeMin, timeMax);
          familyEvents.push(...fEvents.map((e) => ({ ...e, calendarLabel: fc.name })));
        } catch (e) {
          logger.warn(`[Calendar] ${fc.name} 行事曆查詢失敗: ${e.message}`);
        }
      }
    }

    const allEvents = [...events, ...familyEvents];
    allEvents.sort((a, b) => new Date(a.start) - new Date(b.start));

    if (allEvents.length === 0) {
      return { text: `${start}${start !== end ? ` ~ ${end}` : ""} 沒有行程。` };
    }

    let text = `=== 行程 (${start}${start !== end ? ` ~ ${end}` : ""}) ===\n`;
    text += `共 ${allEvents.length} 個事件\n`;

    for (const evt of allEvents) {
      const timeStr = evt.allDay ? "全天" : `${evt.startTime}-${evt.endTime}`;
      text += `\n${timeStr} | ${evt.summary}`;
      if (evt.location) text += ` (${evt.location})`;
      if (evt.calendarLabel) text += ` [${evt.calendarLabel}]`;
      text += `\n  eventId: ${evt.id}`;
    }

    return { text };
  } catch (error) {
    logger.error(`[Calendar] 查詢失敗: ${error.message}`);
    return { text: `行事曆查詢失敗：${error.message}` };
  }
}

/**
 * 新增事件（含衝突偵測）
 */
async function addEvent(calendarName, summary, startTime, endTime, description) {
  if (!isAvailable()) {
    return { text: "行事曆功能未啟用。" };
  }

  const calendar = getCalendarClient();
  const calId = resolveCalendar(calendarName);

  logger.info(`[Calendar] 新增事件: ${summary} ${startTime} ~ ${endTime}`);

  try {
    // 判斷是否全天事件
    const isAllDay = startTime.length === 10; // YYYY-MM-DD

    const event = {
      summary,
      description: description || "",
    };

    if (isAllDay) {
      event.start = { date: startTime };
      event.end = { date: endTime || startTime };
    } else {
      event.start = { dateTime: ensureTimezone(startTime), timeZone: "Asia/Taipei" };
      event.end = { dateTime: ensureTimezone(endTime), timeZone: "Asia/Taipei" };
    }

    // 衝突偵測
    if (!isAllDay) {
      const conflicts = await checkConflicts(calendar, calId, event.start.dateTime, event.end.dateTime);
      if (conflicts.length > 0) {
        const conflictList = conflicts.map((c) => `  - ${c.startTime}-${c.endTime} ${c.summary}`).join("\n");
        logger.info(`[Calendar] 偵測到 ${conflicts.length} 個衝突事件`);

        const res = await calendar.events.insert({ calendarId: calId, resource: event });
        return {
          text: `⚠️ 注意：有 ${conflicts.length} 個時間衝突的事件：\n${conflictList}\n\n已新增事件「${summary}」（eventId: ${res.data.id}）`,
        };
      }
    }

    const res = await calendar.events.insert({ calendarId: calId, resource: event });
    const dateLabel = isAllDay ? startTime : startTime.slice(0, 16).replace("T", " ");
    return { text: `已新增事件「${summary}」在 ${dateLabel}\neventId: ${res.data.id}` };
  } catch (error) {
    logger.error(`[Calendar] 新增事件失敗: ${error.message}`);
    return { text: `新增事件失敗：${error.message}` };
  }
}

/**
 * 更新事件
 */
async function updateEvent(eventId, calendarName, updates) {
  if (!isAvailable()) {
    return { text: "行事曆功能未啟用。" };
  }

  const calendar = getCalendarClient();
  const calId = resolveCalendar(calendarName);

  logger.info(`[Calendar] 更新事件 ${eventId}`);

  try {
    const patch = {};
    if (updates.summary) patch.summary = updates.summary;
    if (updates.description) patch.description = updates.description;
    if (updates.startTime) {
      const isAllDay = updates.startTime.length === 10;
      patch.start = isAllDay
        ? { date: updates.startTime }
        : { dateTime: ensureTimezone(updates.startTime), timeZone: "Asia/Taipei" };
    }
    if (updates.endTime) {
      const isAllDay = updates.endTime.length === 10;
      patch.end = isAllDay
        ? { date: updates.endTime }
        : { dateTime: ensureTimezone(updates.endTime), timeZone: "Asia/Taipei" };
    }

    await calendar.events.patch({
      calendarId: calId,
      eventId,
      resource: patch,
    });

    const changedFields = Object.keys(patch).join(", ");
    return { text: `已更新事件（${changedFields}）\neventId: ${eventId}` };
  } catch (error) {
    logger.error(`[Calendar] 更新事件失敗: ${error.message}`);
    return { text: `更新事件失敗：${error.message}` };
  }
}

/**
 * 刪除事件
 */
async function deleteEvent(eventId, calendarName) {
  if (!isAvailable()) {
    return { text: "行事曆功能未啟用。" };
  }

  const calendar = getCalendarClient();
  const calId = resolveCalendar(calendarName);

  logger.info(`[Calendar] 刪除事件 ${eventId}`);

  try {
    // 先取得事件資訊
    let eventTitle = eventId;
    try {
      const evt = await calendar.events.get({ calendarId: calId, eventId });
      eventTitle = evt.data.summary || eventId;
    } catch {}

    await calendar.events.delete({ calendarId: calId, eventId });
    return { text: `已刪除事件「${eventTitle}」` };
  } catch (error) {
    logger.error(`[Calendar] 刪除事件失敗: ${error.message}`);
    return { text: `刪除事件失敗：${error.message}` };
  }
}

// === 內部工具函式 ===

async function fetchEvents(calendar, calId, timeMin, timeMax) {
  const res = await calendar.events.list({
    calendarId: calId,
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 50,
  });

  return (res.data.items || []).map((item) => {
    const startDt = item.start?.dateTime;
    const endDt = item.end?.dateTime;
    return {
      id: item.id,
      summary: item.summary || "（無標題）",
      start: startDt || item.start?.date,
      end: endDt || item.end?.date,
      startTime: startDt ? startDt.slice(11, 16) : "",
      endTime: endDt ? endDt.slice(11, 16) : "",
      allDay: !startDt,
      location: item.location || "",
      description: item.description || "",
    };
  });
}

async function checkConflicts(calendar, calId, startDateTime, endDateTime) {
  const events = await fetchEvents(calendar, calId, startDateTime, endDateTime);
  return events.filter((e) => !e.allDay); // 全天事件不算衝突
}

function ensureTimezone(timeStr) {
  if (!timeStr) return timeStr;
  // 如果已有時區資訊（+08:00 或 Z），直接返回
  if (/[Z+-]\d{2}:\d{2}$/.test(timeStr) || timeStr.endsWith("Z")) return timeStr;
  // 否則加上台灣時區
  return timeStr + "+08:00";
}

module.exports = { isAvailable, getEvents, addEvent, updateEvent, deleteEvent };
