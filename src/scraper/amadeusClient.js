// =============================================
// Amadeus API 航班查詢模組
//
// 使用 Amadeus Flight Offers Search API 查詢航班
// 比 RPA 爬蟲可靠 100 倍：
// - 不會被封鎖（官方 API）
// - 1-2 秒回傳結果
// - 包含價格、機型、航班號、艙等、轉機資訊
//
// 註冊免費帳號：https://developers.amadeus.com/
// 免費方案：測試環境無限、正式環境 500 次/月
// =============================================

const Amadeus = require("amadeus");
const logger = require("../utils/logger");
const { config } = require("../config");

let amadeus = null;

// 航空公司代碼 → 中文名稱
const CARRIER_NAMES = {
  CI: "華航", BR: "長榮", JX: "星宇", EK: "阿聯酋",
  TK: "土耳其航空", CX: "國泰", SQ: "新加坡航空",
  NH: "全日空", JL: "日航", KE: "大韓航空", OZ: "韓亞航空",
  AA: "美國航空", UA: "聯合航空", DL: "達美航空",
  CZ: "南方航空", CA: "中國國航", MU: "東方航空",
  QR: "卡達航空", TG: "泰航", MH: "馬航", GA: "印尼航空",
  QF: "澳航", AY: "芬蘭航空", LH: "漢莎航空",
  AF: "法航", BA: "英航", KL: "荷航",
};

// 艙等代碼 → 中文
const CABIN_NAMES = {
  ECONOMY: "經濟艙",
  PREMIUM_ECONOMY: "豪華經濟艙",
  BUSINESS: "商務艙",
  FIRST: "頭等艙",
};

/**
 * 取得 Amadeus client（延遲初始化）
 */
function getClient() {
  if (amadeus) return amadeus;

  const clientId = config.amadeus?.clientId;
  const clientSecret = config.amadeus?.clientSecret;

  if (!clientId || !clientSecret) {
    return null;
  }

  amadeus = new Amadeus({
    clientId,
    clientSecret,
    hostname: config.amadeus?.production ? "production" : "test",
  });

  logger.info(`[Amadeus] 已初始化 (${config.amadeus?.production ? "production" : "test"} 環境)`);
  return amadeus;
}

/**
 * 帶超時的 Promise（防止 API 卡死）
 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超時（${ms / 1000}秒）`)), ms);
    promise
      .then((r) => { clearTimeout(timer); resolve(r); })
      .catch((e) => { clearTimeout(timer); reject(e); });
  });
}

const AMADEUS_TIMEOUT = 15000; // 15 秒超時

/**
 * 搜尋航班（現金票）
 *
 * @param {Object} params
 * @param {string[]} airlines - 指定航空公司 IATA 代碼
 * @returns {{ success: boolean, flights: Array, error?: string }}
 */
async function searchFlights(params, airlines = []) {
  const client = getClient();
  if (!client) {
    return { success: false, error: "未設定 Amadeus API 金鑰 (AMADEUS_CLIENT_ID / AMADEUS_CLIENT_SECRET)" };
  }

  const { origin, destination, departDate, returnDate, adults = 1, cabinClass } = params;

  logger.info(`[Amadeus] 搜尋 ${origin}→${destination} ${departDate} cabin=${cabinClass || "ALL"} airlines=[${airlines.join(",")}]`);

  try {
    const queryParams = {
      originLocationCode: origin,
      destinationLocationCode: destination,
      departureDate: departDate,
      adults: String(adults),
      currencyCode: "TWD",
      max: "20",
    };

    if (returnDate) {
      queryParams.returnDate = returnDate;
    }

    if (cabinClass) {
      queryParams.travelClass = cabinClass;
    }

    if (airlines.length > 0) {
      queryParams.includedAirlineCodes = airlines.join(",");
    }

    // 加上超時保護，防止 Amadeus API 無回應導致整個 bot 卡死
    const response = await withTimeout(
      client.shopping.flightOffersSearch.get(queryParams),
      AMADEUS_TIMEOUT,
      "Amadeus API"
    );

    const dictionaries = response.result?.dictionaries || {};
    const offers = response.data || [];

    logger.info(`[Amadeus] 收到 ${offers.length} 筆航班報價`);

    // 轉換為我們的統一格式
    const flights = offers.map((offer, index) => parseOffer(offer, dictionaries, index + 1)).flat();

    return {
      success: flights.length > 0,
      flights,
      totalResults: flights.length,
      source: "amadeus",
    };
  } catch (error) {
    const errMsg = error.response?.body
      ? JSON.stringify(error.response.body).slice(0, 200)
      : error.message;
    logger.error(`[Amadeus] 查詢失敗: ${errMsg}`);
    return { success: false, error: `Amadeus API 錯誤: ${errMsg}` };
  }
}

/**
 * 快速測試 Amadeus API 連線（用於 /health 端點）
 */
async function testConnection() {
  const client = getClient();
  if (!client) {
    return { success: false, error: "未設定 API 金鑰" };
  }
  try {
    // 用一個簡單查詢測試連線（只取 1 筆）
    const response = await withTimeout(
      client.shopping.flightOffersSearch.get({
        originLocationCode: "TPE",
        destinationLocationCode: "NRT",
        departureDate: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
        adults: "1",
        max: "1",
      }),
      10000,
      "Amadeus 測試"
    );
    const count = response.data?.length || 0;
    return { success: true, message: `連線成功，取得 ${count} 筆測試結果` };
  } catch (error) {
    const errMsg = error.response?.body
      ? JSON.stringify(error.response.body).slice(0, 200)
      : error.message;
    return { success: false, error: errMsg };
  }
}

/**
 * 解析單一報價為航班資料
 */
function parseOffer(offer, dictionaries, rank) {
  const results = [];
  const price = offer.price;
  const totalPrice = Math.round(parseFloat(price?.grandTotal || price?.total || 0));
  const currency = price?.currency || "TWD";

  // 每個行程方向（去程 / 回程）
  for (let itinIdx = 0; itinIdx < (offer.itineraries || []).length; itinIdx++) {
    const itinerary = offer.itineraries[itinIdx];
    const segments = itinerary.segments || [];
    const isOutbound = itinIdx === 0;

    if (segments.length === 0) continue;

    const firstSeg = segments[0];
    const lastSeg = segments[segments.length - 1];

    // 航班號：主要航段
    const flightNumbers = segments.map((s) => `${s.carrierCode}${s.number}`);
    const mainCarrier = firstSeg.carrierCode;

    // 航空公司名稱
    const airlineName =
      CARRIER_NAMES[mainCarrier] ||
      dictionaries.carriers?.[mainCarrier] ||
      mainCarrier;

    // 機型
    const aircraftCodes = segments.map((s) => s.aircraft?.code).filter(Boolean);
    const aircraftNames = aircraftCodes.map(
      (code) => dictionaries.aircraft?.[code] || code
    );

    // 艙等（從 travelerPricings 取得）
    let cabinClass = "ECONOMY";
    let cabinName = "經濟艙";
    const fareDetails = offer.travelerPricings?.[0]?.fareDetailsBySegment;
    if (fareDetails && fareDetails.length > 0) {
      cabinClass = fareDetails[0].cabin || "ECONOMY";
      cabinName = CABIN_NAMES[cabinClass] || cabinClass;
    }

    // 轉機次數
    const stops = segments.length - 1;

    // 出發 / 到達時間
    const departTime = formatTime(firstSeg.departure?.at);
    const arriveTime = formatTime(lastSeg.arrival?.at);

    // 飛行時間
    const duration = parseDuration(itinerary.duration);

    results.push({
      rank,
      airline: mainCarrier,
      airlineName,
      flightNumber: flightNumbers.join(" / "),
      departTime,
      arriveTime,
      duration,
      price: isOutbound ? totalPrice : undefined, // 價格只在去程顯示（是來回總價）
      currency,
      stops,
      cabinClass,
      cabinName,
      aircraft: aircraftNames.join(", "),
      direction: isOutbound ? "outbound" : "inbound",
      seatsLeft: offer.numberOfBookableSeats ? `剩${offer.numberOfBookableSeats}席` : "",
      type: "cash",
      source: "amadeus",
    });
  }

  return results;
}

/**
 * ISO 8601 duration → 中文
 * "PT12H30M" → "12小時30分"
 */
function parseDuration(isoDuration) {
  if (!isoDuration) return "";
  const match = isoDuration.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!match) return isoDuration;
  const h = match[1] ? `${match[1]}小時` : "";
  const m = match[2] ? `${match[2]}分` : "";
  return h + m;
}

/**
 * ISO 時間 → HH:mm
 * "2026-03-26T08:30:00" → "08:30"
 */
function formatTime(isoTime) {
  if (!isoTime) return "--:--";
  const match = isoTime.match(/T(\d{2}:\d{2})/);
  return match ? match[1] : "--:--";
}

/**
 * 檢查 Amadeus API 是否可用
 */
function isAvailable() {
  return !!(config.amadeus?.clientId && config.amadeus?.clientSecret);
}

module.exports = {
  searchFlights,
  isAvailable,
  testConnection,
  CARRIER_NAMES,
  CABIN_NAMES,
};
