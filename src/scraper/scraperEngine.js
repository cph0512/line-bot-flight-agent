// =============================================
// 爬蟲引擎 - 統一管理所有航空公司爬蟲
//
// 功能：
// 1. 同時查詢多家航空公司（並行）
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

// 註冊所有可用的航空公司爬蟲
const SCRAPERS = {
  CI: chinaAirlines,
  BR: evaAir,
  JX: starlux,
};

// 限制同時執行的爬蟲數量（避免記憶體爆掉）
const queue = new PQueue({ concurrency: config.browser.maxPages });

/**
 * 搜尋所有航空公司的現金票
 *
 * @param {Object} params - 搜尋參數
 * @param {string[]} airlines - 要查詢的航空公司代碼，空陣列 = 查全部
 */
async function searchCashFlights(params, airlines = []) {
  const targetAirlines = airlines.length > 0
    ? airlines.filter((code) => SCRAPERS[code])
    : Object.keys(SCRAPERS);

  logger.info(`開始查詢 ${targetAirlines.length} 家航空公司現金票`, { airlines: targetAirlines });

  // 並行查詢所有航空公司
  const results = await Promise.allSettled(
    targetAirlines.map((code) =>
      queue.add(() => {
        logger.info(`排隊查詢 ${SCRAPERS[code].AIRLINE.name}...`);
        return SCRAPERS[code].searchCash(params);
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

  logger.info(`開始查詢 ${targetAirlines.length} 家航空公司里程票`, { airlines: targetAirlines });

  const results = await Promise.allSettled(
    targetAirlines.map((code) =>
      queue.add(() => SCRAPERS[code].searchMiles(params))
    )
  );

  return aggregateResults(results, targetAirlines, "miles");
}

/**
 * 同時搜尋現金票 + 里程票（完整比價）
 */
async function searchAll(params, airlines = []) {
  logger.info("🔍 開始完整比價搜尋（現金 + 里程）");

  const [cashResults, milesResults] = await Promise.all([
    searchCashFlights(params, airlines),
    searchMilesFlights(params, airlines),
  ]);

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

    if (result.status === "fulfilled" && result.value.success) {
      allFlights.push(...(result.value.flights || []));
      successAirlines.push(airlineName);
    } else {
      const errorMsg = result.status === "rejected"
        ? result.reason?.message
        : result.value?.error;
      errors.push({ airline: airlineName, error: errorMsg });
      logger.warn(`${airlineName} 查詢失敗`, { error: errorMsg });
    }
  });

  // 排序：現金票按價格，里程票按里程數
  if (type === "cash") {
    allFlights.sort((a, b) => (a.price || 0) - (b.price || 0));
  } else {
    allFlights.sort((a, b) => (a.miles || 0) - (b.miles || 0));
  }

  // 重新排名
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

/**
 * 產生現金 vs 里程的比較分析
 */
function generateComparison(cashFlights, milesFlights) {
  if (cashFlights.length === 0 && milesFlights.length === 0) {
    return "找不到任何航班。";
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
        ? `💡 里程兌換划算！每哩價值約 NT$${mv.valuePerMile}，比現金票省 ${formatPrice(mv.savings)}\n`
        : `💡 現金購買較划算。里程等值約 ${formatPrice(mv.totalEquivalent)}，超過現金票價。\n`;
    }
  }

  return analysis;
}

/**
 * 把搜尋結果格式化成文字，給 AI 閱讀和分析
 */
function formatResultsForAI(result) {
  // 完整比價結果
  if (result.cash && result.miles) {
    let text = "=== 航班比價結果 ===\n\n";

    // 現金票
    text += "【💰 現金票】\n";
    if (result.cash.flights.length > 0) {
      result.cash.flights.slice(0, 8).forEach((f) => {
        text += `${f.rank}. ${f.airlineName} ${f.flightNumber} `;
        text += `${f.departTime}→${f.arriveTime} `;
        text += `${formatPrice(f.price)} `;
        text += f.stops === 0 ? "直飛" : `轉機${f.stops}次`;
        text += "\n";
      });
    } else {
      text += "查無現金票結果\n";
    }

    // 里程票
    text += "\n【🎯 里程兌換票】\n";
    if (result.miles.flights.length > 0) {
      result.miles.flights.slice(0, 8).forEach((f) => {
        text += `${f.rank}. ${f.airlineName} ${f.flightNumber} `;
        text += `${f.departTime}→${f.arriveTime} `;
        text += `${formatMiles(f.miles)}`;
        if (f.taxes) text += ` + 稅金 ${formatPrice(f.taxes)}`;
        text += "\n";
      });
    } else {
      text += "查無里程票結果（可能未設定會員帳號）\n";
    }

    // 比較分析
    if (result.comparison) {
      text += `\n【📊 分析】\n${result.comparison}`;
    }

    // 錯誤報告
    const allErrors = [...(result.cash.errors || []), ...(result.miles.errors || [])];
    if (allErrors.length > 0) {
      text += `\n⚠️ 部分航空公司查詢失敗：${allErrors.map((e) => e.airline).join(", ")}`;
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
    text += `${f.departTime}→${f.arriveTime} `;
    if (r.type === "cash") {
      text += formatPrice(f.price);
    } else {
      text += formatMiles(f.miles);
      if (f.taxes) text += ` + 稅金 ${formatPrice(f.taxes)}`;
    }
    text += f.stops === 0 ? " 直飛" : ` 轉機${f.stops}次`;
    text += "\n";
  });

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
  // 加入第三方比價網站
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
