// =============================================
// 通勤路況服務 — Google Maps Directions API
//
// 每天 8:15（平日）推播即時路況與預估抵達時間
// 也支援 AI 工具隨時查詢
// =============================================

const cron = require("node-cron");
const logger = require("../utils/logger");
const { config } = require("../config");
const { lineClient } = require("../line/lineClient");

function isAvailable() {
  return !!config.commute?.googleMapsApiKey && config.commute?.routes?.length > 0;
}

/**
 * 初始化 cron 排程
 */
function initCron() {
  if (!isAvailable()) {
    logger.info("[Commute] 未設定通勤路況，跳過排程初始化");
    return;
  }

  const time = config.commute.time || "08:15";
  const [hour, minute] = time.split(":");
  const dayOfWeek = config.commute.weekdayOnly ? "1-5" : "*";
  const cronExpr = `${parseInt(minute)} ${parseInt(hour)} * * ${dayOfWeek}`;

  cron.schedule(cronExpr, async () => {
    logger.info("[Commute] === 開始通勤路況推播 ===");
    try {
      await triggerCommuteNotification();
    } catch (error) {
      logger.error(`[Commute] 推播失敗: ${error.message}`);
    }
  }, {
    timezone: config.commute.timezone || "Asia/Taipei",
  });

  logger.info(`[Commute] 通勤路況已排程: ${time} (${config.commute.weekdayOnly ? "週一至五" : "每日"})`);
  logger.info(`[Commute] 路線: ${config.commute.routes.map(r => r.name).join(", ")}`);
}

/**
 * 呼叫 Google Maps Directions API
 */
async function fetchDirections(origin, destination) {
  const url = new URL("https://maps.googleapis.com/maps/api/directions/json");
  url.searchParams.set("origin", origin);
  url.searchParams.set("destination", destination);
  url.searchParams.set("departure_time", "now");
  url.searchParams.set("language", "zh-TW");
  url.searchParams.set("alternatives", "true");
  url.searchParams.set("key", config.commute.googleMapsApiKey);

  logger.info(`[Commute] 查詢: ${origin} → ${destination}`);

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    throw new Error(`Google Maps API 錯誤 ${res.status}`);
  }

  const data = await res.json();

  if (data.status !== "OK") {
    throw new Error(`Directions API: ${data.status}${data.error_message ? " — " + data.error_message : ""}`);
  }

  return data;
}

/**
 * 解析路線結果
 */
function parseRoutes(data) {
  return data.routes.map((route) => {
    const leg = route.legs[0];
    const duration = leg.duration?.value || 0; // 秒（無車流）
    const durationText = leg.duration?.text || "";
    const durationInTraffic = leg.duration_in_traffic?.value || duration; // 秒（含車流）
    const durationInTrafficText = leg.duration_in_traffic?.text || durationText;
    const distance = leg.distance?.text || "";
    const summary = route.summary || "";
    const ratio = duration > 0 ? durationInTraffic / duration : 1;

    return {
      summary,
      distance,
      duration,
      durationText,
      durationInTraffic,
      durationInTrafficText,
      ratio,
      startAddress: leg.start_address || "",
      endAddress: leg.end_address || "",
    };
  });
}

/**
 * 塞車程度 emoji + 文字
 */
function trafficStatus(ratio) {
  if (ratio <= 1.1) return { emoji: "🟢", label: "順暢" };
  if (ratio <= 1.3) return { emoji: "🟡", label: "略壅塞" };
  if (ratio <= 1.5) return { emoji: "🟠", label: "壅塞" };
  return { emoji: "🔴", label: "嚴重壅塞" };
}

/**
 * 格式化通勤訊息
 */
function formatCommuteMessage(routeName, routes) {
  if (!routes || routes.length === 0) {
    return `🚗 ${routeName}：無法取得路線資訊`;
  }

  // 按即時時間排序（最快的在前）
  routes.sort((a, b) => a.durationInTraffic - b.durationInTraffic);

  let text = `📍 ${routeName}\n`;

  routes.forEach((r, i) => {
    const status = trafficStatus(r.ratio);
    const slowPercent = Math.round((r.ratio - 1) * 100);
    const slowText = slowPercent > 5 ? `比平時慢 ${slowPercent}%` : "正常";

    if (i === 0) {
      // 最快路線
      text += `\n🏆 最快：${r.summary}\n`;
      text += `  ⏱️ ${r.durationInTrafficText}（平時 ${r.durationText}）\n`;
      text += `  📏 ${r.distance}\n`;
      text += `  ${status.emoji} ${status.label}｜${slowText}\n`;
    } else {
      // 替代路線
      text += `\n📌 替代：${r.summary}\n`;
      text += `  ⏱️ ${r.durationInTrafficText}（平時 ${r.durationText}）\n`;
      text += `  ${status.emoji} ${status.label}\n`;
    }
  });

  return text;
}

/**
 * 取得通勤路況（AI 工具 + 手動查詢）
 */
async function getCommuteInfo(routeName) {
  if (!isAvailable()) {
    return { text: "通勤路況功能未啟用（未設定 GOOGLE_MAPS_API_KEY 或 COMMUTE_ROUTES）。" };
  }

  const allRoutes = config.commute.routes;

  // 如果指定路線名稱，只查該條
  const targetRoutes = routeName
    ? allRoutes.filter((r) => r.name.includes(routeName) || routeName.includes(r.name))
    : allRoutes;

  if (targetRoutes.length === 0) {
    const available = allRoutes.map((r) => r.name).join("、");
    return { text: `找不到「${routeName}」路線。可用路線：${available}` };
  }

  const now = new Date();
  const days = ["日", "一", "二", "三", "四", "五", "六"];
  const dateLabel = `${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")} (${days[now.getDay()]})`;
  const timeLabel = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  let text = `🚗 通勤路況 ${dateLabel} ${timeLabel}\n`;

  for (const route of targetRoutes) {
    try {
      const data = await fetchDirections(route.origin, route.destination);
      const parsed = parseRoutes(data);
      text += `\n${formatCommuteMessage(route.name, parsed)}`;
      logger.info(`[Commute] ${route.name}: ${parsed.length} 條路線，最快 ${parsed[0]?.durationInTrafficText}`);
    } catch (e) {
      logger.error(`[Commute] ${route.name} 查詢失敗: ${e.message}`);
      text += `\n📍 ${route.name}\n  ⚠️ 查詢失敗：${e.message}\n`;
    }
  }

  return { text };
}

/**
 * 排程推播（cron 觸發）
 */
async function triggerCommuteNotification() {
  const result = await getCommuteInfo();

  // 推播給晨報接收者
  const recipients = config.briefing?.recipients || [];
  let sentCount = 0;

  for (const userId of recipients) {
    try {
      await lineClient.pushMessage({
        to: userId.trim(),
        messages: [{ type: "text", text: result.text }],
      });
      sentCount++;
      logger.info(`[Commute] 已推播給 ${userId.slice(-6)}`);
    } catch (error) {
      logger.error(`[Commute] 推播失敗 ${userId.slice(-6)}: ${error.message}`);
    }
  }

  logger.info(`[Commute] 推播完成: ${sentCount}/${recipients.length} 人`);
  return result;
}

module.exports = { isAvailable, initCron, triggerCommuteNotification, getCommuteInfo };
