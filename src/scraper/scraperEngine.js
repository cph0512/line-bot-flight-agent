// =============================================
// 爬蟲引擎 - 統一管理所有航空公司爬蟲
//
// 功能：
// 1. 同時查詢多家航空公司（並行，帶超時）
// 2. 合併結果並排序
// 3. 比較現金票 vs 里程票
// 4. 產生給 AI 閱讀的摘要
// =============================================

const PQueue = require("p-queue").default;
const logger = require("../utils/logger");
const { formatPrice, formatMiles, calculateMilesValue } = require("../utils/helpers");
const { config } = require("../config");

// 載入各航空公司爬蟲模組
const chinaAirlines = require("./airlines/chinaAirlines");
const evaAir = require("./airlines/evaAir");
const starlux = require("./airlines/starlux");
const emirates = require("./airlines/emirates");
const turkishAirlines = require("./airlines/turkishAirlines");
const cathayPacific = require("./airlines/cathayPacific");
const singaporeAirlines = require("./airlines/singaporeAirlines");

// 註冊所有可用的航空公司爬蟲
const SCRAPERS = {
  CI: chinaAirlines,
  BR: evaAir,
  JX: starlux,
  EK: emirates,
  TK: turkishAirlines,
  CX: cathayPacific,
  SQ: singaporeAirlines,
};

// 限制同時執行的爬蟲數量
const queue = new PQueue({ concurrency: config.browser.maxPages });

// 每個航空公司的超時時間（毫秒）
const PER_AIRLINE_TIMEOUT = 40000; // 40 秒

/**
 * 帶超時的 Promise 包裝
 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} 查詢超時（${ms / 1000}秒）`));
    }, ms);

    promise
      .then((result) => { clearTimeout(timer); resolve(result); })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });
}

/**
 * 搜尋所有航空公司的現金票
 */
async function searchCashFlights(params, airlines = []) {
  const targetAirlines = airlines.length > 0
    ? airlines.filter((code) => SCRAPERS[code])
    : Object.keys(SCRAPERS);

  logger.info(`[Engine] 開始查詢 ${targetAirlines.length} 家航空公司現金票`, { airlines: targetAirlines });

  const results = await Promise.allSettled(
    targetAirlines.map((code) =>
      queue.add(() => {
        const name = SCRAPERS[code].AIRLINE.name;
        logger.info(`[Engine] >>> 開始查詢 ${name}(${code})...`);
        const startTime = Date.now();

        return withTimeout(
          SCRAPERS[code].searchCash(params),
          PER_AIRLINE_TIMEOUT,
          name
        ).then((result) => {
          const elapsed = Date.now() - startTime;
          logger.info(`[Engine] <<< ${name}(${code}) 完成 (${elapsed}ms): success=${result.success} flights=${result.flights?.length || 0}`);
          return result;
        }).catch((err) => {
          const elapsed = Date.now() - startTime;
          logger.error(`[Engine] <<< ${name}(${code}) 失敗 (${elapsed}ms): ${err.message}`);
          return { success: false, error: err.message };
        });
      })
    )
  );

  return aggregateResults(results, targetAirlines, "cash");
}

/**
 * 搜尋所有航空公司的里程票
 */
async function searchMilesFlights(params, airlines = []) {
  const targetAirlines = airlines.length > 0
    ? airlines.filter((code) => SCRAPERS[code])
    : Object.keys(SCRAPERS);

  logger.info(`[Engine] 開始查詢 ${targetAirlines.length} 家航空公司里程票`);

  const results = await Promise.allSettled(
    targetAirlines.map((code) =>
      queue.add(() =>
        withTimeout(
          SCRAPERS[code].searchMiles(params),
          PER_AIRLINE_TIMEOUT,
          SCRAPERS[code].AIRLINE.name
        ).catch((err) => ({ success: false, error: err.message }))
      )
    )
  );

  return aggregateResults(results, targetAirlines, "miles");
}

/**
 * 同時搜尋現金票 + 里程票（完整比價）
 */
async function searchAll(params, airlines = []) {
  logger.info("[Engine] === 開始完整比價搜尋（現金 + 里程）===");

  const [cashResults, milesResults] = await Promise.all([
    searchCashFlights(params, airlines),
    searchMilesFlights(params, airlines),
  ]);

  logger.info(`[Engine] === 比價完成 === cash=${cashResults.flights.length}筆 miles=${milesResults.flights.length}筆 errors=${(cashResults.errors?.length || 0) + (milesResults.errors?.length || 0)}`);

  // 計算里程票的現金等值
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

/**
 * 合併多家航空公司的結果
 */
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
      logger.warn(`[Engine] ${airlineName}(${code}) 查詢失敗: ${errorMsg}`);
    }
  });

  // 排序
  if (type === "cash") {
    allFlights.sort((a, b) => (a.price || 0) - (b.price || 0));
  } else {
    allFlights.sort((a, b) => (a.miles || 0) - (b.miles || 0));
  }

  allFlights.forEach((f, i) => (f.rank = i + 1));

  logger.info(`[Engine] 彙整完成: type=${type} success=[${successAirlines.join(",")}] failed=[${errors.map((e) => e.code).join(",")}] totalFlights=${allFlights.length}`);

  return {
    success: allFlights.length > 0,
    type,
    flights: allFlights,
    totalResults: allFlights.length,
    queriedAirlines: successAirlines,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * 產生現金 vs 里程的比較分析
 */
function generateComparison(cashFlights, milesFlights) {
  if (cashFlights.length === 0 && milesFlights.length === 0) {
    return "找不到任何航班。所有航空公司查詢都失敗了。";
  }

  const cheapestCash = cashFlights[0];
  const cheapestMiles = milesFlights[0];

  let analysis = "";

  if (cheapestCash) {
    analysis += `最便宜現金票：${cheapestCash.airlineName} ${formatPrice(cheapestCash.price)}\n`;
  }

  if (cheapestMiles && cheapestMiles.miles > 0) {
    analysis += `最少里程票：${cheapestMiles.airlineName} ${formatMiles(cheapestMiles.miles)}`;
    if (cheapestMiles.taxes) {
      analysis += ` + 稅金 ${formatPrice(cheapestMiles.taxes)}`;
    }
    analysis += "\n";

    if (cheapestMiles.milesValue) {
      const mv = cheapestMiles.milesValue;
      analysis += mv.worthIt
        ? `里程兌換划算！每哩價值約 NT$${mv.valuePerMile}，比現金票省 ${formatPrice(mv.savings)}\n`
        : `現金購買較划算。里程等值約 ${formatPrice(mv.totalEquivalent)}，超過現金票價。\n`;
    }
  }

  return analysis;
}

/**
 * 把搜尋結果格式化成文字，給 AI 閱讀
 */
function formatResultsForAI(result) {
  // 完整比價結果
  if (result.cash && result.miles) {
    let text = "=== 航班比價結果 ===\n\n";

    text += "【現金票】\n";
    if (result.cash.flights.length > 0) {
      text += `成功查詢：${result.cash.queriedAirlines?.join(", ") || "無"}\n`;
      result.cash.flights.slice(0, 8).forEach((f) => {
        text += `${f.rank}. ${f.airlineName} ${f.flightNumber} `;
        text += `${f.departTime}->${f.arriveTime} `;
        text += `${formatPrice(f.price)} `;
        text += f.cabinName ? `[${f.cabinName}] ` : "";
        text += f.stops === 0 ? "直飛" : `轉機${f.stops}次`;
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

    if (result.comparison) {
      text += `\n【分析】\n${result.comparison}`;
    }

    // 錯誤報告 - 讓 AI 知道哪些航空公司失敗了
    const allErrors = [...(result.cash.errors || []), ...(result.miles.errors || [])];
    if (allErrors.length > 0) {
      // 去重複
      const uniqueErrors = [...new Map(allErrors.map((e) => [e.code, e])).values()];
      text += `\n\n⚠️ 以下航空公司查詢失敗：\n`;
      uniqueErrors.forEach((e) => {
        text += `- ${e.airline}(${e.code}): ${e.error}\n`;
      });
    }

    return text;
  }

  // 單一類型結果
  const r = result;
  let text = `=== ${r.type === "cash" ? "現金票" : "里程票"}搜尋結果 ===\n`;
  text += `查詢航空公司：${r.queriedAirlines?.join(", ") || "無"}\n`;
  text += `找到 ${r.totalResults} 筆航班\n\n`;

  r.flights.slice(0, 10).forEach((f) => {
    text += `${f.rank}. ${f.airlineName} ${f.flightNumber} `;
    text += `${f.departTime}->${f.arriveTime} `;
    if (r.type === "cash") {
      text += formatPrice(f.price);
    } else {
      text += formatMiles(f.miles);
      if (f.taxes) text += ` + 稅金 ${formatPrice(f.taxes)}`;
    }
    text += f.stops === 0 ? " 直飛" : ` 轉機${f.stops}次`;
    text += "\n";
  });

  if (r.errors && r.errors.length > 0) {
    text += `\n⚠️ 查詢失敗的航空公司：\n`;
    r.errors.forEach((e) => {
      text += `- ${e.airline}(${e.code}): ${e.error}\n`;
    });
  }

  return text;
}

/**
 * 取得航空公司的訂票連結
 */
function getBookingLinks(params) {
  const links = [];
  for (const [code, scraper] of Object.entries(SCRAPERS)) {
    if (scraper.getBookingUrl) {
      links.push({
        airline: scraper.AIRLINE.name,
        url: scraper.getBookingUrl(params),
      });
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
