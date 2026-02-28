// =============================================
// 天氣服務 — CWA 氣象署 Open Data API
//
// 端點：
// F-C0032-001：36 小時天氣預報
// F-D0047-091：一週天氣預報
//
// 免費註冊：https://opendata.cwa.gov.tw/
// =============================================

const logger = require("../utils/logger");
const { config } = require("../config");

// 台灣縣市別名對照（使用者輸入 → CWA 正式名稱）
const CITY_ALIAS = {
  台北: "臺北市", 臺北: "臺北市", 台北市: "臺北市",
  新北: "新北市", 新北市: "新北市",
  桃園: "桃園市", 桃園市: "桃園市",
  台中: "臺中市", 臺中: "臺中市", 台中市: "臺中市",
  台南: "臺南市", 臺南: "臺南市", 台南市: "臺南市",
  高雄: "高雄市", 高雄市: "高雄市",
  基隆: "基隆市", 基隆市: "基隆市",
  新竹: "新竹市", 新竹市: "新竹市", 新竹縣: "新竹縣",
  嘉義: "嘉義市", 嘉義市: "嘉義市", 嘉義縣: "嘉義縣",
  苗栗: "苗栗縣", 苗栗縣: "苗栗縣",
  彰化: "彰化縣", 彰化縣: "彰化縣",
  南投: "南投縣", 南投縣: "南投縣",
  雲林: "雲林縣", 雲林縣: "雲林縣",
  屏東: "屏東縣", 屏東縣: "屏東縣",
  宜蘭: "宜蘭縣", 宜蘭縣: "宜蘭縣",
  花蓮: "花蓮縣", 花蓮縣: "花蓮縣",
  台東: "臺東縣", 臺東: "臺東縣", 台東縣: "臺東縣",
  澎湖: "澎湖縣", 澎湖縣: "澎湖縣",
  金門: "金門縣", 金門縣: "金門縣",
  連江: "連江縣", 連江縣: "連江縣", 馬祖: "連江縣",
};

const BASE_URL = "https://opendata.cwa.gov.tw/api/v1/rest/datastore";

function isAvailable() {
  return !!config.cwa?.apiKey;
}

/**
 * 解析城市名稱
 */
function resolveCity(input) {
  if (!input) return null;
  const trimmed = input.trim();

  // 直接對照
  if (CITY_ALIAS[trimmed]) return CITY_ALIAS[trimmed];

  // 嘗試加上「市」或「縣」
  if (CITY_ALIAS[trimmed + "市"]) return CITY_ALIAS[trimmed + "市"];
  if (CITY_ALIAS[trimmed + "縣"]) return CITY_ALIAS[trimmed + "縣"];

  // 模糊比對：檢查是否包含某個 key
  for (const [alias, official] of Object.entries(CITY_ALIAS)) {
    if (trimmed.includes(alias) || alias.includes(trimmed)) {
      return official;
    }
  }

  return null;
}

/**
 * 查詢天氣
 * @param {string} cityInput - 城市名稱
 * @param {number} days - 預報天數（1=36hr, 2-7=一週）
 */
async function getWeather(cityInput, days = 1) {
  if (!isAvailable()) {
    return { text: "天氣查詢功能未啟用（未設定 CWA_API_KEY）。" };
  }

  const city = resolveCity(cityInput);
  if (!city) {
    return { text: `找不到「${cityInput}」的天氣資料。\n支援台灣各縣市，例如：台北、新北、桃園、台中、台南、高雄等。` };
  }

  logger.info(`[Weather] 查詢 ${city} ${days}天預報`);

  try {
    if (days <= 1) {
      return await fetch36Hour(city);
    } else {
      return await fetchWeekly(city);
    }
  } catch (error) {
    logger.error(`[Weather] 查詢失敗: ${error.message}`);
    return { text: `天氣查詢失敗：${error.message}` };
  }
}

/**
 * 36 小時預報
 */
async function fetch36Hour(city) {
  const url = `${BASE_URL}/F-C0032-001?Authorization=${config.cwa.apiKey}&locationName=${encodeURIComponent(city)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CWA API 回傳 ${res.status}`);

  const data = await res.json();
  const location = data.records?.location?.[0];
  if (!location) return { text: `查無「${city}」的天氣資料。` };

  const elements = {};
  for (const el of location.weatherElement || []) {
    elements[el.elementName] = el.time || [];
  }

  let text = `=== ${city} 天氣預報 ===\n`;

  const timeSlots = elements.Wx || [];
  for (const slot of timeSlots) {
    const start = formatDateShort(slot.startTime);
    const end = formatDateShort(slot.endTime);
    const wx = slot.parameter?.parameterName || "—";
    const pop = findElementValue(elements.PoP, slot.startTime);
    const minT = findElementValue(elements.MinT, slot.startTime);
    const maxT = findElementValue(elements.MaxT, slot.startTime);
    const ci = findElementValue(elements.CI, slot.startTime);

    text += `\n${start} ~ ${end}\n`;
    text += `  天氣: ${wx}\n`;
    text += `  溫度: ${minT}°C - ${maxT}°C\n`;
    text += `  降雨機率: ${pop}%\n`;
    if (ci) text += `  舒適度: ${ci}\n`;
  }

  // 出門建議
  const suggestions = generateSuggestions(elements);
  if (suggestions.length > 0) {
    text += `\n💡 建議:\n${suggestions.join("\n")}`;
  }

  return { text };
}

/**
 * 一週預報
 */
async function fetchWeekly(city) {
  const url = `${BASE_URL}/F-D0047-091?Authorization=${config.cwa.apiKey}&locationName=${encodeURIComponent(city)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CWA API 回傳 ${res.status}`);

  const data = await res.json();
  const location = data.records?.locations?.[0]?.location?.[0];
  if (!location) return { text: `查無「${city}」的一週天氣資料。` };

  const elements = {};
  for (const el of location.weatherElement || []) {
    elements[el.elementName] = el.time || [];
  }

  let text = `=== ${city} 一週天氣預報 ===\n`;

  // Wx = 天氣, T = 溫度, PoP12h = 降雨機率
  const wxSlots = elements.Wx || [];
  const seen = new Set();

  for (const slot of wxSlots.slice(0, 14)) { // 7天×2 = 14 個時段
    const dateStr = slot.startTime?.slice(0, 10);
    const dayLabel = formatDayLabel(slot.startTime);
    const period = slot.startTime?.slice(11, 13) === "06" ? "白天" : "晚上";
    const wx = slot.elementValue?.[0]?.value || "—";

    // 找對應溫度和降雨
    const t = findWeeklyValue(elements.T, slot.startTime);
    const pop = findWeeklyValue(elements.PoP12h, slot.startTime);

    // 日期分隔
    if (!seen.has(dateStr)) {
      seen.add(dateStr);
      text += `\n📅 ${dayLabel}\n`;
    }

    text += `  ${period}: ${wx} ${t}°C`;
    if (pop) text += ` 降雨${pop}%`;
    text += "\n";
  }

  return { text };
}

/**
 * 生成出門建議
 */
function generateSuggestions(elements) {
  const suggestions = [];
  const pops = (elements.PoP || []).map((t) => parseInt(t.parameter?.parameterName || "0"));
  const minTs = (elements.MinT || []).map((t) => parseInt(t.parameter?.parameterName || "20"));
  const maxTs = (elements.MaxT || []).map((t) => parseInt(t.parameter?.parameterName || "25"));

  const maxPop = Math.max(...pops, 0);
  const minTemp = Math.min(...minTs, 99);
  const maxTemp = Math.max(...maxTs, 0);
  const tempDiff = maxTemp - minTemp;

  if (maxPop >= 60) suggestions.push("🌂 降雨機率高，記得帶傘！");
  else if (maxPop >= 30) suggestions.push("🌂 可能下雨，建議帶傘");

  if (minTemp < 15) suggestions.push("🧣 氣溫偏低，注意保暖");
  if (tempDiff >= 10) suggestions.push("🧥 早晚溫差大，建議帶外套");
  if (maxTemp >= 33) suggestions.push("☀️ 高溫注意防曬補水");

  return suggestions;
}

// === 工具函式 ===

function findElementValue(timeArray, startTime) {
  if (!timeArray) return "—";
  const match = timeArray.find((t) => t.startTime === startTime);
  return match?.parameter?.parameterName || "—";
}

function findWeeklyValue(timeArray, startTime) {
  if (!timeArray) return "";
  const match = timeArray.find((t) => t.startTime === startTime);
  return match?.elementValue?.[0]?.value || "";
}

function formatDateShort(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:00`;
}

function formatDayLabel(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  const days = ["日", "一", "二", "三", "四", "五", "六"];
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd} (${days[d.getDay()]})`;
}

module.exports = { isAvailable, getWeather, resolveCity };
