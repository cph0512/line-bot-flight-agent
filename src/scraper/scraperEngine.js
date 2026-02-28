// =============================================
// 爬蟲引擎（雙軌版）
//
// 策略：
// 1. 優先使用 Amadeus API（快速可靠）
// 2. API 不可用或失敗時，使用 RPA Stealth 爬蟲
// 3. 都失敗時，回傳官網連結
// =============================================

const PQueue = require("p-queue").default;
const logger = require("../utils/logger");
const { formatPrice, formatMiles, calculateMilesValue } = require("../utils/helpers");
const { config } = require("../config");
const amadeusClient = require("./amadeusClient");

// RPA 爬蟲模組
const chinaAirlines = require("./airlines/chinaAirlines");
const evaAir = require("./airlines/evaAir");
const starlux = require("./airlines/starlux");
const emirates = require("./airlines/emirates");
const turkishAirlines = require("./airlines/turkishAirlines");
const cathayPacific = require("./airlines/cathayPacific");
const singaporeAirlines = require("./airlines/singaporeAirlines");

const SCRAPERS = {
  CI: chinaAirlines,
  BR: evaAir,
  JX: starlux,
  EK: emirates,
  TK: turkishAirlines,
  CX: cathayPacific,
  SQ: singaporeAirlines,
};

const queue = new PQueue({ concurrency: config.browser.maxPages });
const PER_AIRLINE_TIMEOUT = 25000; // 從 40 秒降到 25 秒

/**
 * 檢查是否有任何里程帳號設定
 */
function hasAnyMileageCredentials(airlines = []) {
  const accounts = config.mileageAccounts || {};
  const targets = airlines.length > 0 ? airlines : Object.keys(accounts);
  return targets.some((code) => accounts[code]?.id && accounts[code]?.password);
}

/**
 * 取得有設定里程帳號的航空公司
 */
function getAirlinesWithMileageCredentials(airlines = []) {
  const accounts = config.mileageAccounts || {};
  const targets = airlines.length > 0 ? airlines : Object.keys(accounts);
  return targets.filter((code) => accounts[code]?.id && accounts[code]?.password);
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超時（${ms / 1000}秒）`)), ms);
    promise
      .then((r) => { clearTimeout(timer); resolve(r); })
      .catch((e) => { clearTimeout(timer); reject(e); });
  });
}

// =============================================
// 主要搜尋函式（雙軌策略）
// =============================================

/**
 * 搜尋現金票 — Amadeus 優先，RPA 備援
 */
async function searchCashFlights(params, airlines = []) {
  logger.info(`[Engine] 搜尋現金票 ${params.origin}→${params.destination} ${params.departDate} cabin=${params.cabinClass || "ALL"}`);

  // 策略 1：Amadeus API（快速可靠）
  if (amadeusClient.isAvailable()) {
    logger.info("[Engine] 使用 Amadeus API 查詢...");
    try {
      const apiResult = await amadeusClient.searchFlights(params, airlines);

      if (apiResult.success && apiResult.flights.length > 0) {
        logger.info(`[Engine] Amadeus 成功：${apiResult.flights.length} 筆航班`);
        // 只取去程航班（outbound）用於顯示
        const outboundFlights = apiResult.flights.filter((f) => f.direction === "outbound");
        return {
          success: true,
          type: "cash",
          flights: outboundFlights.length > 0 ? outboundFlights : apiResult.flights,
          totalResults: outboundFlights.length || apiResult.flights.length,
          queriedAirlines: [...new Set(apiResult.flights.map((f) => f.airlineName))],
          source: "amadeus",
        };
      }

      logger.warn(`[Engine] Amadeus 失敗：${apiResult.error || "無結果"}`);
    } catch (err) {
      logger.error(`[Engine] Amadeus 異常：${err.message}`);
    }
  }

  // 策略 2：RPA Stealth 爬蟲（備援）— 但用更短的超時
  logger.info("[Engine] 改用 RPA Stealth 爬蟲...");
  try {
    return await withTimeout(
      searchCashFlightsRPA(params, airlines),
      35000,
      "RPA 爬蟲總計"
    );
  } catch (rpaErr) {
    logger.error(`[Engine] RPA 也失敗: ${rpaErr.message}`);
    return {
      success: false,
      type: "cash",
      flights: [],
      totalResults: 0,
      queriedAirlines: [],
      errors: [{ airline: "全部", code: "ALL", error: `Amadeus+RPA 都失敗` }],
    };
  }
}

/**
 * RPA 爬蟲搜尋現金票
 */
async function searchCashFlightsRPA(params, airlines = []) {
  const targetAirlines = airlines.length > 0
    ? airlines.filter((code) => SCRAPERS[code])
    : Object.keys(SCRAPERS);

  logger.info(`[Engine/RPA] 查詢 ${targetAirlines.length} 家航空公司`, { airlines: targetAirlines });

  const results = await Promise.allSettled(
    targetAirlines.map((code) =>
      queue.add(() => {
        const name = SCRAPERS[code].AIRLINE.name;
        logger.info(`[Engine/RPA] >>> ${name}(${code})...`);
        const startTime = Date.now();

        return withTimeout(SCRAPERS[code].searchCash(params), PER_AIRLINE_TIMEOUT, name)
          .then((result) => {
            logger.info(`[Engine/RPA] <<< ${name}(${code}) ${Date.now() - startTime}ms: ${result.success ? "成功" : "失敗"} ${result.flights?.length || 0}筆`);
            return result;
          })
          .catch((err) => {
            logger.error(`[Engine/RPA] <<< ${name}(${code}) ${Date.now() - startTime}ms: ${err.message}`);
            return { success: false, error: err.message };
          });
      })
    )
  );

  return aggregateResults(results, targetAirlines, "cash");
}

/**
 * 搜尋里程票（只查有設定帳號的航空公司）
 */
async function searchMilesFlights(params, airlines = []) {
  // 只查有設定里程帳號的航空公司 — 沒帳號的不浪費時間
  const targetAirlines = getAirlinesWithMileageCredentials(airlines)
    .filter((code) => SCRAPERS[code]);

  if (targetAirlines.length === 0) {
    logger.info("[Engine] 沒有設定任何里程帳號，跳過里程搜尋");
    return {
      success: false,
      type: "miles",
      flights: [],
      totalResults: 0,
      queriedAirlines: [],
      errors: [{ airline: "全部", code: "ALL", error: "未設定里程帳號" }],
    };
  }

  logger.info(`[Engine] 搜尋里程票，有帳號的航空公司: [${targetAirlines.join(",")}]`);

  const results = await Promise.allSettled(
    targetAirlines.map((code) =>
      queue.add(() =>
        withTimeout(SCRAPERS[code].searchMiles(params), PER_AIRLINE_TIMEOUT, SCRAPERS[code].AIRLINE.name)
          .catch((err) => ({ success: false, error: err.message }))
      )
    )
  );

  return aggregateResults(results, targetAirlines, "miles");
}

/**
 * 完整比價（現金 + 里程）
 * 策略：先查現金（Amadeus 快速），有里程帳號才查里程
 */
async function searchAll(params, airlines = []) {
  logger.info("[Engine] === 開始完整比價 ===");

  // 先確認是否需要查里程
  const hasMilesCredentials = hasAnyMileageCredentials(airlines);

  let cashResults, milesResults;

  if (hasMilesCredentials) {
    // 有里程帳號：並行查詢現金+里程
    logger.info("[Engine] 有里程帳號，現金+里程並行查詢");
    [cashResults, milesResults] = await Promise.all([
      searchCashFlights(params, airlines),
      searchMilesFlights(params, airlines),
    ]);
  } else {
    // 沒有里程帳號：只查現金（超快！）
    logger.info("[Engine] 無里程帳號，只查現金票（Amadeus）");
    cashResults = await searchCashFlights(params, airlines);
    milesResults = {
      success: false,
      type: "miles",
      flights: [],
      totalResults: 0,
      queriedAirlines: [],
      errors: [{ airline: "全部", code: "ALL", error: "未設定里程帳號" }],
    };
  }

  logger.info(`[Engine] === 比價完成 === cash=${cashResults.flights?.length || 0}筆(${cashResults.source || "rpa"}) miles=${milesResults.flights?.length || 0}筆`);

  const cheapestCash = cashResults.flights[0]?.price || 0;
  const milesWithValue = milesResults.flights.map((mf) => {
    const value = cheapestCash > 0
      ? calculateMilesValue(mf.miles, mf.taxes || 0, cheapestCash)
      : null;
    return { ...mf, milesValue: value };
  });

  return {
    cash: cashResults,
    miles: { ...milesResults, flights: milesWithValue },
    comparison: generateComparison(cashResults.flights, milesWithValue),
  };
}

// =============================================
// 結果處理
// =============================================

function aggregateResults(results, airlineCodes, type) {
  const allFlights = [];
  const errors = [];
  const successAirlines = [];

  results.forEach((result, index) => {
    const code = airlineCodes[index];
    const airlineName = SCRAPERS[code]?.AIRLINE?.name || code;

    if (result.status === "fulfilled" && result.value && result.value.success) {
      allFlights.push(...(result.value.flights || []));
      successAirlines.push(airlineName);
    } else {
      const errorMsg = result.status === "rejected"
        ? result.reason?.message
        : result.value?.error || "未知錯誤";
      errors.push({ airline: airlineName, code, error: errorMsg });
    }
  });

  if (type === "cash") {
    allFlights.sort((a, b) => (a.price || 0) - (b.price || 0));
  } else {
    allFlights.sort((a, b) => (a.miles || 0) - (b.miles || 0));
  }
  allFlights.forEach((f, i) => (f.rank = i + 1));

  return {
    success: allFlights.length > 0,
    type,
    flights: allFlights,
    totalResults: allFlights.length,
    queriedAirlines: successAirlines,
    errors: errors.length > 0 ? errors : undefined,
  };
}

function generateComparison(cashFlights, milesFlights) {
  if (cashFlights.length === 0 && milesFlights.length === 0) {
    return "找不到任何航班。";
  }

  const cheapestCash = cashFlights[0];
  const cheapestMiles = milesFlights[0];
  let analysis = "";

  if (cheapestCash) {
    analysis += `最便宜現金票：${cheapestCash.airlineName} ${cheapestCash.flightNumber} ${formatPrice(cheapestCash.price)}`;
    if (cheapestCash.aircraft) analysis += ` (${cheapestCash.aircraft})`;
    analysis += "\n";
  }

  if (cheapestMiles && cheapestMiles.miles > 0) {
    analysis += `最少里程票：${cheapestMiles.airlineName} ${formatMiles(cheapestMiles.miles)}`;
    if (cheapestMiles.taxes) analysis += ` + 稅金 ${formatPrice(cheapestMiles.taxes)}`;
    analysis += "\n";
    if (cheapestMiles.milesValue) {
      const mv = cheapestMiles.milesValue;
      analysis += mv.worthIt
        ? `里程兌換划算！每哩 NT$${mv.valuePerMile}，省 ${formatPrice(mv.savings)}\n`
        : `現金購買較划算。里程等值 ${formatPrice(mv.totalEquivalent)}。\n`;
    }
  }

  return analysis;
}

/**
 * 格式化結果給 AI 閱讀
 */
function formatResultsForAI(result) {
  if (result.cash && result.miles) {
    let text = "=== 航班比價結果 ===\n";
    if (result.cash.source === "amadeus") {
      text += "(資料來源：Amadeus 全球航空訂位系統)\n";
    }
    text += "\n";

    text += "【現金票】\n";
    if (result.cash.flights.length > 0) {
      text += `查詢到的航空公司：${result.cash.queriedAirlines?.join(", ")}\n`;
      result.cash.flights.slice(0, 10).forEach((f) => {
        text += `${f.rank}. ${f.airlineName} ${f.flightNumber} `;
        text += `${f.departTime}->${f.arriveTime} `;
        if (f.price) text += `${formatPrice(f.price)} `;
        if (f.cabinName) text += `[${f.cabinName}] `;
        text += f.stops === 0 ? "直飛" : `轉機${f.stops}次`;
        if (f.aircraft) text += ` (${f.aircraft})`;
        if (f.duration) text += ` ${f.duration}`;
        text += "\n";
      });
    } else {
      text += "查無現金票結果\n";
    }

    text += "\n【里程兌換票】\n";
    if (result.miles.flights.length > 0) {
      result.miles.flights.slice(0, 8).forEach((f) => {
        text += `${f.rank}. ${f.airlineName} ${f.flightNumber} `;
        text += `${f.departTime}->${f.arriveTime} `;
        text += `${formatMiles(f.miles)}`;
        if (f.taxes) text += ` + 稅金 ${formatPrice(f.taxes)}`;
        text += "\n";
      });
    } else {
      text += "查無里程票結果（可能未設定會員帳號）\n";
    }

    if (result.comparison) text += `\n【分析】\n${result.comparison}`;

    const allErrors = [...(result.cash.errors || []), ...(result.miles.errors || [])];
    if (allErrors.length > 0) {
      const unique = [...new Map(allErrors.map((e) => [e.code, e])).values()];
      text += `\n⚠️ 部分航空公司查詢失敗：${unique.map((e) => `${e.airline}`).join(", ")}`;
    }

    return text;
  }

  // 單一類型
  const r = result;
  let text = `=== ${r.type === "cash" ? "現金票" : "里程票"}結果 ===\n`;
  text += `航空公司：${r.queriedAirlines?.join(", ") || "無"}\n`;
  text += `找到 ${r.totalResults} 筆\n\n`;

  r.flights.slice(0, 10).forEach((f) => {
    text += `${f.rank}. ${f.airlineName} ${f.flightNumber} `;
    text += `${f.departTime}->${f.arriveTime} `;
    if (r.type === "cash") text += formatPrice(f.price);
    else {
      text += formatMiles(f.miles);
      if (f.taxes) text += ` + ${formatPrice(f.taxes)}`;
    }
    text += f.stops === 0 ? " 直飛" : ` 轉機${f.stops}次`;
    if (f.aircraft) text += ` (${f.aircraft})`;
    text += "\n";
  });

  return text;
}

function getBookingLinks(params) {
  const links = [];
  for (const [code, scraper] of Object.entries(SCRAPERS)) {
    if (scraper.getBookingUrl) {
      links.push({ airline: scraper.AIRLINE.name, url: scraper.getBookingUrl(params) });
    }
  }
  links.push({
    airline: "Google Flights",
    url: `https://www.google.com/travel/flights?q=flights+from+${params.origin}+to+${params.destination}+on+${params.departDate}`,
  });
  links.push({
    airline: "Skyscanner",
    url: `https://www.skyscanner.com.tw/transport/flights/${params.origin.toLowerCase()}/${params.destination.toLowerCase()}/${params.departDate.replace(/-/g, "")}/`,
  });
  return links;
}

module.exports = {
  searchCashFlights,
  searchMilesFlights,
  searchAll,
  formatResultsForAI,
  getBookingLinks,
  SCRAPERS,
};
