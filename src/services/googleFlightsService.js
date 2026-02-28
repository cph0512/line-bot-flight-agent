// =============================================
// Google Flights 搜尋服務（透過 RapidAPI google-flights2）
//
// 免費 150 次/月，GET 請求即可取得即時航班資訊
// 包含：航班搜尋、機場搜尋、價格日曆
// =============================================

const { config } = require("../config");
const logger = require("../utils/logger");

const BASE_URL = "https://google-flights2.p.rapidapi.com/api/v1";
const HOST = "google-flights2.p.rapidapi.com";

/**
 * 檢查是否可用（有 RapidAPI Key）
 */
function isAvailable() {
  return !!config.rapidapi?.key;
}

/**
 * 通用 API 呼叫
 */
async function apiCall(endpoint, params = {}, method = "GET", body = null) {
  if (!isAvailable()) {
    throw new Error("未設定 RAPIDAPI_KEY，Google Flights 搜尋不可用");
  }

  const url = new URL(`${BASE_URL}${endpoint}`);
  if (method === "GET") {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
  }

  logger.info(`[GoogleFlights] ${method} ${endpoint}`, { params });

  const fetchOptions = {
    method,
    headers: {
      "X-RapidAPI-Key": config.rapidapi.key,
      "X-RapidAPI-Host": HOST,
    },
    signal: AbortSignal.timeout(30000),
  };

  if (method === "POST" && body) {
    fetchOptions.headers["Content-Type"] = "application/json";
    fetchOptions.body = JSON.stringify(body);
  }

  const res = await fetch(url.toString(), fetchOptions);

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Google Flights API 錯誤 ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();

  if (data.status === false) {
    throw new Error(`API 回傳錯誤: ${data.message || "未知錯誤"}`);
  }

  return data;
}

// ================================================================
// 搜尋航班（主要功能）
// ================================================================

/**
 * 搜尋航班
 * @param {Object} params
 * @param {string} params.origin - 出發機場 IATA (e.g. TPE)
 * @param {string} params.destination - 目的地機場 IATA (e.g. NRT)
 * @param {string} params.departDate - 出發日期 YYYY-MM-DD
 * @param {string} [params.returnDate] - 回程日期 YYYY-MM-DD（單程不填）
 * @param {number} [params.adults=1] - 成人人數
 * @param {number} [params.children=0] - 兒童人數 (2-11歲)
 * @param {string} [params.cabinClass=ECONOMY] - 艙等
 * @param {string} [params.currency=TWD] - 幣別
 * @returns {{ text: string, flights: Array }}
 */
async function searchFlights(params) {
  const {
    origin,
    destination,
    departDate,
    returnDate,
    adults = 1,
    children = 0,
    cabinClass = "ECONOMY",
    currency = "TWD",
  } = params;

  logger.info(`[GoogleFlights] 搜尋: ${origin}→${destination} ${departDate}${returnDate ? " 回 " + returnDate : " 單程"}`);

  const apiParams = {
    departure_id: origin,
    arrival_id: destination,
    outbound_date: departDate,
    adults: String(adults),
    children: String(children),
    travel_class: cabinClass,
    currency,
    language_code: "zh-TW",
    country_code: "TW",
    show_hidden: "1",
  };

  if (returnDate) {
    apiParams.return_date = returnDate;
  }

  const data = await apiCall("/searchFlights", apiParams);

  // 解析回應
  const flights = parseFlightResults(data);

  if (flights.length === 0) {
    return {
      text: `未找到 ${origin}→${destination} ${departDate} 的航班。建議調整日期或目的地。`,
      flights: [],
    };
  }

  const text = formatFlightsText(flights, origin, destination, departDate, returnDate, currency);
  return { text, flights };
}

/**
 * 解析航班搜尋結果
 * 根據官方文件，回傳格式為：
 * data.itineraries.topFlights[] — 推薦航班
 * data.itineraries.otherFlights[] — 其他航班
 * data.best_flights[] / data.other_flights[] — 另一種格式
 */
function parseFlightResults(data) {
  const flights = [];
  const responseData = data.data || data;

  // 格式 1: data.itineraries.topFlights / otherFlights
  const itineraries = responseData.itineraries || {};
  const topFlights = itineraries.topFlights || itineraries.top_flights || [];
  const otherFlights = itineraries.otherFlights || itineraries.other_flights || [];

  // 格式 2: data.best_flights / other_flights (直接在 data 下)
  const bestFlights = responseData.best_flights || responseData.bestFlights || [];
  const otherFlights2 = responseData.other_flights || responseData.otherFlights || [];

  // 合併所有結果
  let allItineraries = [];
  if (topFlights.length > 0 || otherFlights.length > 0) {
    allItineraries = [...topFlights, ...otherFlights];
  } else if (bestFlights.length > 0 || otherFlights2.length > 0) {
    allItineraries = [...bestFlights, ...otherFlights2];
  } else if (Array.isArray(itineraries)) {
    // 格式 3: data.itineraries 是陣列
    allItineraries = itineraries;
  }

  for (const itin of allItineraries.slice(0, 10)) {
    const flight = parseItinerary(itin);
    if (flight) flights.push(flight);
  }

  // 按價格排序
  flights.sort((a, b) => (a.price || 999999) - (b.price || 999999));

  return flights;
}

/**
 * 解析單一行程
 * 實際 API 回傳格式：
 * {
 *   departure_time: "01-04-2026 02:40 AM",
 *   arrival_time: "01-04-2026 10:05 AM",
 *   duration: { raw: 385, text: "6 hr 25 min" },
 *   price: 7469,
 *   stops: 0,  // ⚠️ API 的 stops 不準，改用 flights.length - 1
 *   flights: [{
 *     departure_airport: { airport_name, airport_code, time },
 *     arrival_airport: { airport_name, airport_code, time },
 *     duration: { raw, text },
 *     airline, airline_logo, flight_number, aircraft, seat, legroom, extensions
 *   }],
 *   layovers: [{ airport_code, airport_name, duration_label, duration, city }],
 *   bags: { carry_on, checked },
 *   carbon_emissions: { difference_percent, CO2e, typical_for_this_route },
 *   airline_logo: "...",
 *   booking_token: "..."
 * }
 */
function parseItinerary(itin) {
  try {
    // 價格（API 回傳已是指定幣別的數字）
    const price = itin.price ?? null;

    // 出發/抵達時間
    const departTime = itin.departure_time || "";
    const arriveTime = itin.arrival_time || "";

    // 飛行時間
    let duration = 0;
    let durationText = "";
    if (itin.duration) {
      if (typeof itin.duration === "object") {
        duration = itin.duration.raw || 0;
        durationText = itin.duration.text || formatDuration(duration);
      } else if (typeof itin.duration === "number") {
        duration = itin.duration;
        durationText = formatDuration(duration);
      }
    }

    // 航段明細
    const legs = itin.flights || [];
    const segments = [];

    for (const leg of legs) {
      segments.push({
        airline: leg.airline || "",
        airlineLogo: leg.airline_logo || "",
        flightNumber: leg.flight_number || "",
        departure: {
          airport: leg.departure_airport?.airport_code || "",
          name: leg.departure_airport?.airport_name || "",
          time: leg.departure_airport?.time || "",
        },
        arrival: {
          airport: leg.arrival_airport?.airport_code || "",
          name: leg.arrival_airport?.airport_name || "",
          time: leg.arrival_airport?.time || "",
        },
        duration: typeof leg.duration === "object" ? leg.duration.raw : (leg.duration || 0),
        durationText: typeof leg.duration === "object" ? leg.duration.text : "",
        aircraft: leg.aircraft || "",
        legroom: leg.legroom || "",
        extensions: leg.extensions || [],
      });
    }

    // 轉機次數（用航段數判斷，不用 API 的 stops 欄位）
    const stops = Math.max(0, segments.length - 1);

    // 航空公司
    const airlines = [...new Set(segments.map(s => s.airline).filter(Boolean))];
    const airline = airlines.join(" / ") || "未知航空";
    const flightNumber = segments.map(s => s.flightNumber).filter(Boolean).join(" → ");

    // 轉機資訊
    const layovers = (itin.layovers || []).map(l => ({
      airport: l.airport_code || "",
      name: l.airport_name || "",
      city: l.city || "",
      duration: l.duration || 0,
      durationLabel: l.duration_label || "",
    }));

    // 如果連基本資料都沒有，跳過
    if (!departTime && !arriveTime && price === null && segments.length === 0) return null;

    return {
      // Flex Message 相容欄位
      airline,
      flightNumber,
      departTime,
      arriveTime,
      stops,
      stopInfo: stops === 0 ? "直飛" : `${stops} 轉`,
      duration,
      durationText,
      price: typeof price === "number" ? price : null,
      currency: "TWD",
      cabinClass: segments[0]?.travelClass || "ECONOMY",
      segments,
      source: "Google Flights",
      // 額外資訊
      airlineLogo: itin.airline_logo || "",
      bookingToken: itin.booking_token || "",
      bags: itin.bags || null,
      carbonEmissions: itin.carbon_emissions || null,
      layovers,
      selfTransfer: itin.self_transfer || false,
    };
  } catch (e) {
    logger.warn(`[GoogleFlights] 解析行程失敗: ${e.message}`);
    return null;
  }
}

// ================================================================
// 機場搜尋
// ================================================================

/**
 * 搜尋機場
 * @param {string} query - 關鍵字（城市名或機場代碼）
 * @returns {{ text: string }}
 */
async function searchAirport(query) {
  const data = await apiCall("/searchAirport", {
    query,
    language_code: "zh-TW",
    country_code: "TW",
  });

  const airports = data.data || [];
  if (!Array.isArray(airports) || airports.length === 0) {
    return { text: `找不到「${query}」相關的機場。` };
  }

  const lines = airports
    .filter(a => a.type === "airport" || a.id?.length === 3)
    .slice(0, 8)
    .map((a, i) => {
      const id = a.id || "";
      const title = a.title || "";
      const city = a.city || "";
      return `${i + 1}. ${id} — ${title}${city ? ` (${city})` : ""}`;
    });

  if (lines.length === 0) {
    return { text: `找不到「${query}」相關的機場。` };
  }

  return { text: `=== 機場搜尋「${query}」===\n${lines.join("\n")}` };
}

// ================================================================
// 價格日曆
// ================================================================

/**
 * 取得價格日曆（最便宜日期）
 */
async function getPriceCalendar(params) {
  const { origin, destination, departDate, returnDate } = params;

  const apiParams = {
    departure_id: origin,
    arrival_id: destination,
    outbound_date: departDate,
    currency: "TWD",
    country_code: "TW",
  };

  if (returnDate) {
    apiParams.return_date = returnDate;
  }

  const data = await apiCall("/getPriceGraph", apiParams);
  const prices = data.data || [];

  if (!Array.isArray(prices) || prices.length === 0) {
    return { text: `無法取得 ${origin}→${destination} 的價格趨勢資料。` };
  }

  let text = `=== ${origin}→${destination} 價格趨勢 ===\n`;

  // 找最低價
  let minPrice = Infinity;
  let minDate = "";
  for (const p of prices) {
    const date = p.departure || p.date || "";
    const price = p.price || 0;
    if (price > 0 && price < minPrice) {
      minPrice = price;
      minDate = date;
    }
  }

  if (minDate) {
    text += `\n💰 最低價日期：${minDate} — NT$${minPrice.toLocaleString()}\n`;
  }

  // 列出價格
  text += `\n日期          價格\n`;
  for (const p of prices.slice(0, 14)) {
    const date = p.departure || p.date || "?";
    const price = p.price || 0;
    const marker = date === minDate ? " ⭐" : "";
    text += `${date}  NT$${price ? price.toLocaleString() : "—"}${marker}\n`;
  }

  return { text };
}

// ================================================================
// 訂票連結
// ================================================================

/**
 * 取得訂票詳情與連結
 */
async function getBookingDetails(bookingToken) {
  const data = await apiCall("/getBookingDetails", {
    booking_token: bookingToken,
    currency: "TWD",
    language_code: "zh-TW",
    country_code: "TW",
  });

  const partners = data.data || [];
  if (!Array.isArray(partners) || partners.length === 0) {
    return { text: "無法取得訂票資訊。", partners: [] };
  }

  let text = "=== 訂票選項 ===\n";
  for (const p of partners.slice(0, 5)) {
    const name = p.partner || p.name || "未知";
    const price = p.price || 0;
    const isAirline = p.is_airline ? " ✈️" : "";
    text += `${name}${isAirline}: NT$${price.toLocaleString()}`;
    if (p.token) text += ` [可訂票]`;
    text += `\n`;
  }

  return { text, partners };
}

/**
 * 取得訂票 URL
 */
async function getBookingUrl(token) {
  const data = await apiCall("/getBookingURL", { token });
  const url = data.data || "";
  return {
    text: url ? `訂票連結：${url}` : "無法取得訂票連結。",
    url: typeof url === "string" ? url : "",
  };
}

// ================================================================
// 格式化工具
// ================================================================

function formatDuration(minutes) {
  if (!minutes || minutes <= 0) return "";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h${m > 0 ? m + "m" : ""}` : `${m}m`;
}

function formatFlightsText(flights, origin, destination, departDate, returnDate, currency) {
  let text = `=== Google Flights 搜尋結果 ===\n`;
  text += `${origin} → ${destination}\n`;
  text += `📅 去程 ${departDate}${returnDate ? ` | 回程 ${returnDate}` : " | 單程"}\n`;
  text += `找到 ${flights.length} 個航班方案\n\n`;

  flights.forEach((f, i) => {
    text += `--- 方案 ${i + 1} ---\n`;
    text += `✈️ ${f.airline}`;
    if (f.flightNumber) text += ` ${f.flightNumber}`;
    text += `\n`;
    text += `🕐 ${f.departTime} → ${f.arriveTime}`;
    if (f.durationText) text += ` (${f.durationText})`;
    text += `\n`;
    text += `📍 ${f.stopInfo}`;
    if (f.stops > 0 && f.layovers?.length > 0) {
      const layoverCities = f.layovers.map(l => `${l.city || l.name}${l.durationLabel ? " " + l.durationLabel : ""}`).filter(Boolean);
      if (layoverCities.length > 0) text += ` — 經 ${layoverCities.join(", ")}`;
    }
    text += `\n`;
    if (f.price) {
      text += `💰 NT$${f.price.toLocaleString()}\n`;
    }
    // 行李
    if (f.bags) {
      const bagInfo = [];
      if (f.bags.carry_on) bagInfo.push(`手提 ${f.bags.carry_on} 件`);
      if (f.bags.checked) bagInfo.push(`托運 ${f.bags.checked} 件`);
      if (bagInfo.length > 0) text += `🧳 ${bagInfo.join(", ")}\n`;
    }
    // 碳排
    if (f.carbonEmissions?.CO2e) {
      const co2kg = Math.round(f.carbonEmissions.CO2e / 1000);
      const diff = f.carbonEmissions.difference_percent || 0;
      const diffText = diff > 0 ? `↑${diff}%` : diff < 0 ? `↓${Math.abs(diff)}%` : "";
      text += `🌱 碳排 ${co2kg}kg CO₂${diffText ? ` (${diffText} vs 平均)` : ""}\n`;
    }
    text += `\n`;
  });

  text += `📎 資料來源：Google Flights（透過 RapidAPI）`;
  return text;
}

module.exports = {
  isAvailable,
  searchFlights,
  searchAirport,
  getPriceCalendar,
  getBookingDetails,
  getBookingUrl,
};
