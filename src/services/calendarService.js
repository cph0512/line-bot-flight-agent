// =============================================
// Google Calendar 行事曆服務
//
// 支援兩種認證模式：
// 1. Service Account（全域，向下相容）
// 2. Per-user OAuth 2.0（多租戶 SaaS）
// =============================================

const { google } = require("googleapis");
const logger = require("../utils/logger");
const { config } = require("../config");

let authClient = null;

// ========== Service Account 認證（向下相容）==========

function getAuth() {
  if (authClient) return authClient;

  const keyFile = config.calendar?.keyFile;
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

  if (keyJson) {
    try {
      let cleaned = keyJson;
      let credentials;
      try {
        credentials = JSON.parse(cleaned);
      } catch {
        cleaned = cleaned.replace(/\n/g, "\\n");
        credentials = JSON.parse(cleaned);
      }
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

// ========== 可用性檢查 ==========

/**
 * 全域 Service Account 是否可用
 */
function isAvailable() {
  const hasKey = !!(config.calendar?.keyFile || process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  return !!(hasKey && config.calendar?.calendarId);
}

/**
 * 取得用戶的 calendar client（優先 OAuth，fallback Service Account）
 * @param {string|null} dbUserId — DB User.id
 * @returns {Object} { client, calendarId, familyCalendars }
 */
async function getUserCalendarContext(dbUserId) {
  // 嘗試 per-user OAuth
  if (dbUserId) {
    try {
      const { getCalendarClientForUser } = require("../auth/googleOAuth");
      const { prisma } = require("../db/prisma");

      if (prisma) {
        const oauthClient = await getCalendarClientForUser(dbUserId);
        if (oauthClient) {
          const googleAuth = await prisma.googleAuth.findUnique({ where: { userId: dbUserId } });
          const familyCals = await prisma.familyCalendar.findMany({ where: { userId: dbUserId } });
          return {
            client: oauthClient,
            calendarId: googleAuth?.calendarId || "primary",
            familyCalendars: familyCals.map((c) => ({ name: c.name, id: c.calendarId })),
            mode: "oauth",
          };
        }
      }
    } catch (e) {
      logger.warn(`[Calendar] OAuth fallback: ${e.message}`);
    }
  }

  // Fallback: Service Account
  if (!isAvailable()) return null;
  return {
    client: getCalendarClient(),
    calendarId: config.calendar.calendarId,
    familyCalendars: config.calendar.familyCalendars || [],
    mode: "service-account",
  };
}

// ========== 行事曆名稱解析 ==========

function resolveCalendar(calendarName, ctx) {
  if (!calendarName || calendarName === "我" || calendarName === "我的" || calendarName === "個人") {
    return ctx.calendarId;
  }

  const family = ctx.familyCalendars || [];
  const match = family.find(
    (c) => c.name === calendarName || c.name.includes(calendarName) || calendarName.includes(c.name)
  );
  return match?.id || ctx.calendarId;
}

// ========== 公開 API ==========

/**
 * 查詢行程
 * @param {string} calendarName
 * @param {string} startDate
 * @param {string} endDate
 * @param {string|null} dbUserId — DB User.id（多租戶模式）
 */
async function getEvents(calendarName, startDate, endDate, dbUserId) {
  const ctx = await getUserCalendarContext(dbUserId);
  if (!ctx) {
    return { text: "行事曆功能未啟用。請先綁定 Google 行事曆。" };
  }

  const calId = resolveCalendar(calendarName, ctx);

  const today = new Date().toISOString().slice(0, 10);
  const start = startDate || today;
  const end = endDate || start;

  const timeMin = new Date(`${start}T00:00:00+08:00`).toISOString();
  const timeMax = new Date(`${end}T23:59:59+08:00`).toISOString();

  logger.info(`[Calendar] 查詢行程 ${calId.slice(0, 20)}... ${start} ~ ${end} (${ctx.mode})`);

  try {
    const events = await fetchEvents(ctx.client, calId, timeMin, timeMax);

    let familyEvents = [];
    if (!calendarName || ["全家", "家庭", "全部", "所有", "all"].includes(calendarName)) {
      for (const fc of ctx.familyCalendars) {
        try {
          const fEvents = await fetchEvents(ctx.client, fc.id, timeMin, timeMax);
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

    const isMultiDay = start !== end;

    for (const evt of allEvents) {
      const evtDate = evt.start ? evt.start.slice(0, 10) : "";
      const datePrefix = isMultiDay && evtDate ? `${evtDate} ` : "";
      const timeStr = evt.allDay ? `${datePrefix}全天` : `${datePrefix}${evt.startTime}-${evt.endTime}`;
      text += `\n${timeStr} | ${evt.summary}`;
      if (evt.location) text += ` (${evt.location})`;
      if (evt.calendarLabel) text += ` [${evt.calendarLabel}]`;
      text += `\n  [id:${evt.id}]`;
    }

    return { text };
  } catch (error) {
    logger.error(`[Calendar] 查詢失敗: ${error.message}`);
    return { text: `行事曆查詢失敗：${error.message}` };
  }
}

/**
 * 新增事件
 */
async function addEvent(calendarName, summary, startTime, endTime, description, dbUserId) {
  const ctx = await getUserCalendarContext(dbUserId);
  if (!ctx) {
    return { text: "行事曆功能未啟用。請先綁定 Google 行事曆。" };
  }

  const calId = resolveCalendar(calendarName, ctx);

  logger.info(`[Calendar] 新增事件: ${summary} ${startTime} ~ ${endTime} (${ctx.mode})`);

  try {
    const isAllDay = startTime.length === 10;

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
      const conflicts = await checkConflicts(ctx.client, calId, event.start.dateTime, event.end.dateTime);
      if (conflicts.length > 0) {
        const conflictList = conflicts.map((c) => `  - ${c.startTime}-${c.endTime} ${c.summary}`).join("\n");
        logger.info(`[Calendar] 偵測到 ${conflicts.length} 個衝突事件`);

        const res = await ctx.client.events.insert({ calendarId: calId, resource: event });
        return {
          text: `⚠️ 注意：有 ${conflicts.length} 個時間衝突的事件：\n${conflictList}\n\n已新增事件「${summary}」[id:${res.data.id}]`,
        };
      }
    }

    const res = await ctx.client.events.insert({ calendarId: calId, resource: event });
    const dateLabel = isAllDay ? startTime : startTime.slice(0, 16).replace("T", " ");
    return { text: `已新增事件「${summary}」在 ${dateLabel} [id:${res.data.id}]` };
  } catch (error) {
    logger.error(`[Calendar] 新增事件失敗: ${error.message}`);
    return { text: `新增事件失敗：${error.message}` };
  }
}

/**
 * 更新事件
 */
async function updateEvent(eventId, calendarName, updates, dbUserId) {
  const ctx = await getUserCalendarContext(dbUserId);
  if (!ctx) {
    return { text: "行事曆功能未啟用。" };
  }

  const calId = resolveCalendar(calendarName, ctx);

  logger.info(`[Calendar] 更新事件 ${eventId} (${ctx.mode})`);

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

    await ctx.client.events.patch({
      calendarId: calId,
      eventId,
      resource: patch,
    });

    const changedFields = Object.keys(patch).join(", ");
    return { text: `已更新事件（${changedFields}）` };
  } catch (error) {
    logger.error(`[Calendar] 更新事件失敗: ${error.message}`);
    return { text: `更新事件失敗：${error.message}` };
  }
}

/**
 * 刪除事件
 */
async function deleteEvent(eventId, calendarName, dbUserId) {
  const ctx = await getUserCalendarContext(dbUserId);
  if (!ctx) {
    return { text: "行事曆功能未啟用。" };
  }

  const calId = resolveCalendar(calendarName, ctx);

  logger.info(`[Calendar] 刪除事件 ${eventId} (${ctx.mode})`);

  try {
    let eventTitle = eventId;
    try {
      const evt = await ctx.client.events.get({ calendarId: calId, eventId });
      eventTitle = evt.data.summary || eventId;
    } catch {}

    await ctx.client.events.delete({ calendarId: calId, eventId });
    return { text: `已刪除事件「${eventTitle}」` };
  } catch (error) {
    logger.error(`[Calendar] 刪除事件失敗: ${error.message}`);
    return { text: `刪除事件失敗：${error.message}` };
  }
}

/**
 * 取得原始事件陣列（供內部服務使用）
 * @param {string} startDate
 * @param {string} endDate
 * @param {string|null} dbUserId — DB User.id
 */
async function getRawEvents(startDate, endDate, dbUserId) {
  const ctx = await getUserCalendarContext(dbUserId);
  if (!ctx) return [];

  const today = new Date().toISOString().slice(0, 10);
  const start = startDate || today;
  const end = endDate || start;

  const timeMin = new Date(`${start}T00:00:00+08:00`).toISOString();
  const timeMax = new Date(`${end}T23:59:59+08:00`).toISOString();

  try {
    const events = await fetchEvents(ctx.client, ctx.calendarId, timeMin, timeMax);

    for (const fc of ctx.familyCalendars) {
      try {
        const fEvents = await fetchEvents(ctx.client, fc.id, timeMin, timeMax);
        events.push(...fEvents.map((e) => ({ ...e, calendarLabel: fc.name })));
      } catch (e) {
        logger.warn(`[Calendar] getRawEvents: ${fc.name} 查詢失敗: ${e.message}`);
      }
    }

    events.sort((a, b) => new Date(a.start) - new Date(b.start));
    return events;
  } catch (error) {
    logger.error(`[Calendar] getRawEvents 失敗: ${error.message}`);
    return [];
  }
}

// ========== 內部工具函式 ==========

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
  return events.filter((e) => !e.allDay);
}

function ensureTimezone(timeStr) {
  if (!timeStr) return timeStr;
  if (/[Z+-]\d{2}:\d{2}$/.test(timeStr) || timeStr.endsWith("Z")) return timeStr;
  return timeStr + "+08:00";
}

module.exports = { isAvailable, getEvents, addEvent, updateEvent, deleteEvent, getRawEvents, getUserCalendarContext };
