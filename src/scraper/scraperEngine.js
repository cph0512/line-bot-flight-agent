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

// 台灣出發最常用的航空公司（RPA 備援時優先查這些）
const PRIORITY_AIRLINES = ["CI", "BR", "JX"];

const queue = new PQueue({ concurrency: config.browser.maxPages });
const PER_AIRLINE_TIMEOUT = 20000; // 每家航空 20 秒
const RPA_TOTAL_TIMEOUT = 30000;   // RPA 總計 30 秒

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

/**
 * 去重航班
 * - 相同航班號+出發時間+價格 = 真正重複（去回程組合造成），只保留一筆
 * - 相同航班號+出發時間但不同價格 = 不同票種等級，全部保留
 */
function deduplicateFlights(flights) {
  const seen = new Set();
  const deduped = [];
  for (const f of flights) {
    // key 包含價格，這樣不同票價等級（Basic/Standard/Up）會被保留
    const key = `${f.flightNumber}|${f.departTime}|${f.price}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(f);
    }
  }
  deduped.sort((a, b) => (a.price || 0) - (b.price || 0));
  deduped.forEach((f, i) => (f.rank = i + 1));
  return deduped;
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
        const outboundRaw = apiResult.flights.filter((f) => f.direction === "outbound");
        const inboundRaw = apiResult.flights.filter((f) => f.direction === "inbound");

        // 去重（Amadeus 會為每個去回程組合產生一筆，同一航班會重複）
        const outbound = deduplicateFlights(outboundRaw);
        const inbound = deduplicateFlights(inboundRaw);

        logger.info(`[Engine] Amadeus 成功：去程=${outbound.length}(原${outboundRaw.length}) 回程=${inbound.length}(原${inboundRaw.length})`);
        return {
          success: true,
          type: "cash",
          flights: outbound.length > 0 ? outbound : apiResult.flights,
          inboundFlights: inbound,
          totalResults: outbound.length + inbound.length,
          queriedAirlines: [...new Set(apiResult.flights.map((f) => f.airlineName))],
          source: "amadeus",
        };
      }

      logger.warn(`[Engine] Amadeus 失敗：${apiResult.error || "無結果"}`);
    } catch (err) {
      logger.error(`[Engine] Amadeus 異常：${err.message}`);
    }
  }

  // 策略 2：RPA Stealth 爬蟲（備援）
  // 如果沒指定航空公司，只查最常用的 3 家（避免全部 7 家太慢超時）
  const rpaAirlines = airlines.length > 0 ? airlines : PRIORITY_AIRLINES;
  logger.info(`[Engine] 改用 RPA 爬蟲 (${rpaAirlines.join(",")})...`);

  try {
    return await withTimeout(
      searchCashFlightsRPA(params, rpaAirlines),
      RPA_TOTAL_TIMEOUT,
      "RPA 爬蟲總計"
    );
  } catch (rpaErr) {
    logger.error(`[Engine] RPA 也失敗: ${rpaErr.message}`);
    return {
      success: false,
      type: "cash",
      flights: [],
      inboundFlights: [],
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
    inbound: cashResults.inboundFlights || [],
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

    text += "【去程航班（現金票）】\n";
    if (result.cash.flights.length > 0) {
      text += `查詢到的航空公司：${result.cash.queriedAirlines?.join(", ")}\n`;
      const hasReturn = (result.inbound || []).length > 0;
      if (hasReturn) text += "（票價為來回總價）\n";
      result.cash.flights.slice(0, 10).forEach((f) => {
        text += `${f.rank}. ${f.airlineName} ${f.flightNumber} `;
        text += `${f.departAirport || ""}→${f.arriveAirport || ""} `;
        text += `${f.departTime}->${f.arriveTime} `;
        if (f.price) text += `${formatPrice(f.price)}${hasReturn ? "(來回)" : ""} `;
        if (f.cabinName) text += `[${f.cabinName}] `;
        text += f.stops === 0 ? "直飛" : `轉機${f.stops}次`;
        if (f.aircraft) text += ` (${f.aircraft})`;
        if (f.duration) text += ` ${f.duration}`;
        text += "\n";
      });
    } else {
      text += "查無現金票結果\n";
    }

    // 回程航班
    const inboundFlights = result.inbound || [];
    if (inboundFlights.length > 0) {
      text += "\n【回程航班】\n";
      inboundFlights.slice(0, 10).forEach((f, i) => {
        text += `${i + 1}. ${f.airlineName} ${f.flightNumber} `;
        text += `${f.departAirport || ""}→${f.arriveAirport || ""} `;
        text += `${f.departTime}->${f.arriveTime} `;
        text += f.stops === 0 ? "直飛" : `轉機${f.stops}次`;
        if (f.aircraft) text += ` (${f.aircraft})`;
        if (f.duration) text += ` ${f.duration}`;
        text += "\n";
      });
      text += "（以上價格皆為來回總價，含去回程）\n";
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
