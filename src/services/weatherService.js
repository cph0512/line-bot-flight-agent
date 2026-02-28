// =============================================
// 天氣服務
//
// 台灣：CWA 氣象署 Open Data API（需 API key）
// 國際：Open-Meteo（免費、不需 API key、全球覆蓋）
//
// 自動判斷：台灣縣市 → CWA，其他城市 → Open-Meteo
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

// WMO 天氣代碼 → 中文描述
const WMO_CODES = {
  0: "晴天", 1: "大致晴", 2: "多雲", 3: "陰天",
  45: "霧", 48: "霧凇",
  51: "小毛雨", 53: "中毛雨", 55: "大毛雨",
  56: "凍毛雨", 57: "強凍毛雨",
  61: "小雨", 63: "中雨", 65: "大雨",
  66: "凍雨", 67: "強凍雨",
  71: "小雪", 73: "中雪", 75: "大雪", 77: "雪粒",
  80: "小陣雨", 81: "中陣雨", 82: "大陣雨",
  85: "小陣雪", 86: "大陣雪",
  95: "雷雨", 96: "雷雨+冰雹", 99: "強雷雨+冰雹",
};

const BASE_URL = "https://opendata.cwa.gov.tw/api/v1/rest/datastore";

/**
 * 天氣功能永遠可用（Open-Meteo 不需 API key）
 */
function isAvailable() {
  return true;
}

/**
 * CWA 是否可用（台灣天氣用）
 */
function isCwaAvailable() {
  return !!config.cwa?.apiKey;
}

/**
 * 解析台灣城市名稱
 */
function resolveCity(input) {
  if (!input) return null;
  const trimmed = input.trim();

  if (CITY_ALIAS[trimmed]) return CITY_ALIAS[trimmed];
  if (CITY_ALIAS[trimmed + "市"]) return CITY_ALIAS[trimmed + "市"];
  if (CITY_ALIAS[trimmed + "縣"]) return CITY_ALIAS[trimmed + "縣"];

  for (const [alias, official] of Object.entries(CITY_ALIAS)) {
    if (trimmed.includes(alias) || alias.includes(trimmed)) {
      return official;
    }
  }

  return null;
}

/**
 * 查詢天氣（自動選擇 CWA 或 Open-Meteo）
 * @param {string} cityInput - 城市名稱（中文或英文）
 * @param {number} days - 預報天數（1=today, 2-7=多天）
 */
async function getWeather(cityInput, days = 1) {
  // 1. 嘗試台灣城市 → CWA
  const twCity = resolveCity(cityInput);
  if (twCity && isCwaAvailable()) {
    logger.info(`[Weather] 台灣城市 ${twCity} → 使用 CWA`);
    try {
      if (days <= 1) {
        return await fetch36Hour(twCity);
      } else {
        return await fetchWeekly(twCity);
      }
    } catch (error) {
      logger.error(`[Weather] CWA 失敗，嘗試 Open-Meteo: ${error.message}`);
      // CWA 失敗 → 降級到 Open-Meteo
    }
  }

  // 2. 國際城市（或 CWA 失敗）→ Open-Meteo
  logger.info(`[Weather] 使用 Open-Meteo 查詢: ${cityInput}`);
  try {
    return await fetchOpenMeteo(cityInput, days);
  } catch (error) {
    logger.error(`[Weather] Open-Meteo 也失敗: ${error.message}`);
    return { text: `天氣查詢失敗：${error.message}` };
  }
}

// ========================================
// Open-Meteo（國際天氣，免費）
// ========================================

/**
 * Open-Meteo Geocoding → 找到城市的經緯度
 */
async function geocodeCity(cityName) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityName)}&count=1&language=zh`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Geocoding API 回傳 ${res.status}`);

  const data = await res.json();
  const result = data.results?.[0];
  if (!result) {
    // 嘗試英文搜尋
    const url2 = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityName)}&count=1&language=en`;
    const res2 = await fetch(url2, { signal: AbortSignal.timeout(5000) });
    if (!res2.ok) throw new Error(`Geocoding API 回傳 ${res2.status}`);
    const data2 = await res2.json();
    const result2 = data2.results?.[0];
    if (!result2) return null;
    return result2;
  }
  return result;
}

/**
 * Open-Meteo 天氣查詢
 */
async function fetchOpenMeteo(cityInput, days) {
  // Step 1: Geocoding
  const geo = await geocodeCity(cityInput);
  if (!geo) {
    return { text: `找不到「${cityInput}」的位置資料。\n請嘗試用英文城市名（例如：Tokyo, London, New York）。` };
  }

  const cityName = geo.name;
  const country = geo.country || "";
  const displayName = country ? `${cityName}, ${country}` : cityName;
  const forecastDays = Math.min(Math.max(days, 1), 7);

  logger.info(`[Weather] Open-Meteo: ${displayName} (${geo.latitude}, ${geo.longitude}) ${forecastDays}天`);

  // Step 2: Weather forecast
  const params = [
    `latitude=${geo.latitude}`,
    `longitude=${geo.longitude}`,
    `daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max`,
    `current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m`,
    `timezone=${encodeURIComponent(geo.timezone || "auto")}`,
    `forecast_days=${forecastDays}`,
  ].join("&");

  const url = `https://api.open-meteo.com/v1/forecast?${params}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Open-Meteo API 回傳 ${res.status}`);

  const data = await res.json();

  // Step 3: 格式化輸出
  let text = `=== ${displayName} 天氣預報 ===\n`;

  // 目前天氣
  if (data.current) {
    const cur = data.current;
    const wxDesc = WMO_CODES[cur.weather_code] || `代碼${cur.weather_code}`;
    text += `\n🌡️ 現在: ${wxDesc} ${cur.temperature_2m}°C\n`;
    text += `  濕度: ${cur.relative_humidity_2m}% | 風速: ${cur.wind_speed_10m} km/h\n`;
  }

  // 每日預報
  const daily = data.daily;
  if (daily && daily.time) {
    text += `\n📅 ${forecastDays}日預報:\n`;

    const dayNames = ["日", "一", "二", "三", "四", "五", "六"];

    for (let i = 0; i < daily.time.length; i++) {
      const date = new Date(daily.time[i] + "T00:00:00");
      const dayName = dayNames[date.getDay()];
      const mm = String(date.getMonth() + 1).padStart(2, "0");
      const dd = String(date.getDate()).padStart(2, "0");
      const wxDesc = WMO_CODES[daily.weather_code[i]] || "—";
      const minT = daily.temperature_2m_min[i];
      const maxT = daily.temperature_2m_max[i];
      const pop = daily.precipitation_probability_max[i];

      text += `\n${mm}/${dd}(${dayName}) ${wxDesc}\n`;
      text += `  溫度: ${minT}°C ~ ${maxT}°C`;
      if (pop != null) text += ` | 降雨: ${pop}%`;
      text += "\n";
    }
  }

  // 出門建議
  const suggestions = generateOpenMeteoSuggestions(data);
  if (suggestions.length > 0) {
    text += `\n💡 建議:\n${suggestions.join("\n")}`;
  }

  return { text };
}

/**
 * Open-Meteo 資料生成出門建議
 */
function generateOpenMeteoSuggestions(data) {
  const suggestions = [];
  const daily = data.daily;
  if (!daily) return suggestions;

  const pops = daily.precipitation_probability_max || [];
  const minTs = daily.temperature_2m_min || [];
  const maxTs = daily.temperature_2m_max || [];

  const maxPop = Math.max(...pops, 0);
  const minTemp = Math.min(...minTs, 99);
  const maxTemp = Math.max(...maxTs, 0);
  const tempDiff = maxTemp - minTemp;

  if (maxPop >= 60) suggestions.push("🌂 降雨機率高，記得帶傘！");
  else if (maxPop >= 30) suggestions.push("🌂 可能下雨，建議帶傘");

  if (minTemp < 5) suggestions.push("🥶 極低溫，注意禦寒！");
  else if (minTemp < 15) suggestions.push("🧣 氣溫偏低，注意保暖");

  if (tempDiff >= 10) suggestions.push("🧥 早晚溫差大，建議帶外套");
  if (maxTemp >= 35) suggestions.push("🥵 高溫警報，注意防曬補水！");
  else if (maxTemp >= 33) suggestions.push("☀️ 高溫注意防曬補水");

  return suggestions;
}

// ========================================
// CWA（台灣天氣）
// ========================================

async function fetch36Hour(city) {
  const url = `${BASE_URL}/F-C0032-001?Authorization=${config.cwa.apiKey}&locationName=${encodeURIComponent(city)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
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

  const suggestions = generateCwaSuggestions(elements);
  if (suggestions.length > 0) {
    text += `\n💡 建議:\n${suggestions.join("\n")}`;
  }

  return { text };
}

async function fetchWeekly(city) {
  const url = `${BASE_URL}/F-D0047-091?Authorization=${config.cwa.apiKey}&locationName=${encodeURIComponent(city)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`CWA API 回傳 ${res.status}`);

  const data = await res.json();
  const location = data.records?.locations?.[0]?.location?.[0];
  if (!location) return { text: `查無「${city}」的一週天氣資料。` };

  const elements = {};
  for (const el of location.weatherElement || []) {
    elements[el.elementName] = el.time || [];
  }

  let text = `=== ${city} 一週天氣預報 ===\n`;

  const wxSlots = elements.Wx || [];
  const seen = new Set();

  for (const slot of wxSlots.slice(0, 14)) {
    const dateStr = slot.startTime?.slice(0, 10);
    const dayLabel = formatDayLabel(slot.startTime);
    const period = slot.startTime?.slice(11, 13) === "06" ? "白天" : "晚上";
    const wx = slot.elementValue?.[0]?.value || "—";

    const t = findWeeklyValue(elements.T, slot.startTime);
    const pop = findWeeklyValue(elements.PoP12h, slot.startTime);

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

function generateCwaSuggestions(elements) {
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
