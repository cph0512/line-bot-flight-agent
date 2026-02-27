// =============================================
// 阿聯酋航空 (Emirates, EK) 爬蟲
//
// 目標網站：https://www.emirates.com/
// 搜尋頁面：https://www.emirates.com/tw/chinese/
//
// 表單結構（繁中版本）：
// - 出發地：input[name="出發機場"] (.js-field-input)
// - 目的地：input[name="目的地機場"] (.js-field-input)
// - 出發日期：#search-flight-date-picker--depart
// - 回程日期：#search-flight-date-picker--return
// - 搜尋按鈕：button 文字「繼續」
// - 結果頁 URL：emirates.com/tw/chinese/book/
//
// ⚠️ 重要：航空公司網站經常改版，
// selector 可能需要定期更新！
// 最後更新：2026-02-27
// =============================================

const { createPage, closePage, humanDelay, takeScreenshot } = require("../browserManager");
const logger = require("../../utils/logger");
const { config } = require("../../config");

const AIRLINE = {
  code: "EK",
  name: "阿聯酋",
  fullName: "阿聯酋航空",
  baseUrl: "https://www.emirates.com",
  bookingUrl: "https://www.emirates.com/tw/chinese/",
};

/**
 * 搜尋阿聯酋航空現金票
 *
 * @param {Object} params
 * @param {string} params.origin       - "TPE"
 * @param {string} params.destination   - "DXB"
 * @param {string} params.departDate    - "2025-03-15"
 * @param {string} params.returnDate    - "2025-03-20" (optional)
 * @param {number} params.adults        - 1
 * @returns {Object} { success, flights, error }
 */
async function searchCash(params) {
  const { origin, destination, departDate, returnDate, adults = 1 } = params;
  let page = null;

  try {
    page = await createPage();
    logger.info(`[阿聯酋] 開始搜尋現金票 ${origin}→${destination} ${departDate}`);

    // === 步驟 1：前往阿聯酋航空首頁 ===
    await page.goto(AIRLINE.bookingUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(page, 2000, 3000);

    // 關閉 cookie 提示
    await dismissCookieBanner(page);

    // === 步驟 2：填寫搜尋表單 ===

    // 填入出發地
    const originInput = page.locator(
      'input[name="出發機場"], input.js-field-input[placeholder*="出發"], input[aria-label*="出發"], input[aria-label*="origin"], input[placeholder*="From"]'
    ).first();
    await originInput.click();
    await humanDelay(page, 300, 600);
    await originInput.fill("");
    await originInput.type(origin, { delay: 100 });
    await humanDelay(page, 1500, 2500);

    // 從下拉選單選擇
    const originOption = page.locator(
      `[role="option"]:has-text("${origin}"), .js-typeahead-item:has-text("${origin}"), li:has-text("${origin}"), .autocomplete-result:has-text("${origin}")`
    ).first();
    if (await originOption.isVisible({ timeout: 5000 })) {
      await originOption.click();
    } else {
      await page.keyboard.press("Enter");
    }
    await humanDelay(page);

    // 填入目的地
    const destInput = page.locator(
      'input[name="目的地機場"], input.js-field-input[placeholder*="目的"], input[aria-label*="目的"], input[aria-label*="destination"], input[placeholder*="To"]'
    ).first();
    await destInput.click();
    await humanDelay(page, 300, 600);
    await destInput.fill("");
    await destInput.type(destination, { delay: 100 });
    await humanDelay(page, 1500, 2500);

    // 從下拉選單選擇
    const destOption = page.locator(
      `[role="option"]:has-text("${destination}"), .js-typeahead-item:has-text("${destination}"), li:has-text("${destination}"), .autocomplete-result:has-text("${destination}")`
    ).first();
    if (await destOption.isVisible({ timeout: 5000 })) {
      await destOption.click();
    } else {
      await page.keyboard.press("Enter");
    }
    await humanDelay(page);

    // 填入出發日期
    await fillDate(page, departDate, "depart");

    // 填入回程日期（如有）
    if (returnDate) {
      await fillDate(page, returnDate, "return");
    }

    // 填入旅客人數
    if (adults > 1) {
      await setPassengerCount(page, adults);
    }

    // === 步驟 3：送出搜尋 ===
    const searchBtn = page.locator(
      'button:has-text("繼續"), button:has-text("搜尋"), button:has-text("Search"), button:has-text("Continue"), button[type="submit"]'
    ).first();
    await searchBtn.click();
    logger.info("[阿聯酋] 已點擊搜尋，等待結果頁...");

    // === 步驟 4：等待結果頁載入 ===
    try {
      await page.waitForURL(/emirates\.com.*book/i, { timeout: 45000 });
    } catch {
      // 可能沒有跳轉 URL，改為等待結果元素
      logger.info("[阿聯酋] URL 未跳轉，嘗試等待頁面內容...");
    }
    await humanDelay(page, 3000, 5000);

    // 等待結果頁的航班卡片出現
    await waitForResults(page);

    logger.info("[阿聯酋] 結果頁已載入");

    // 截圖（除錯用）
    if (config.server.nodeEnv === "development") {
      await takeScreenshot(page, "ek-results");
    }

    // === 步驟 5：解析結果 ===
    const flights = await parseFlightResults(page);

    if (flights.length === 0) {
      return { success: true, flights: [], message: "阿聯酋查無此航線或日期的航班" };
    }

    return {
      success: true,
      airline: AIRLINE,
      flights: flights.map((f) => ({ ...f, airline: "EK", airlineName: "阿聯酋", type: "cash" })),
    };
  } catch (error) {
    logger.error("[阿聯酋] 現金票搜尋失敗", { error: error.message });
    if (page && config.server.nodeEnv === "development") {
      await takeScreenshot(page, "ek-error");
    }
    return { success: false, error: `阿聯酋搜尋失敗：${error.message}` };
  } finally {
    await closePage(page);
  }
}

/**
 * 搜尋阿聯酋航空里程票（開發中）
 */
async function searchMiles(params) {
  return { success: false, error: "阿聯酋里程票爬蟲開發中" };
}

// === 內部輔助函式 ===

/**
 * 關閉 cookie 提示
 */
async function dismissCookieBanner(page) {
  try {
    const cookieBtn = page.locator(
      'button:has-text("接受"), button:has-text("我同意"), button:has-text("Accept"), button[id*="cookie"], button[class*="cookie"]'
    ).first();
    if (await cookieBtn.isVisible({ timeout: 3000 })) {
      await cookieBtn.click();
      await humanDelay(page, 300, 600);
    }
  } catch {}
}

/**
 * 填入日期
 * 嘗試多種方式：先嘗試 Emirates 特定的日期選擇器，再用 JS 設值
 */
async function fillDate(page, dateStr, type) {
  const [year, month, day] = dateStr.split("-");

  try {
    if (type === "depart") {
      // 嘗試點擊出發日期欄位
      const dateInput = page.locator(
        '#search-flight-date-picker--depart, input[name*="depart"], input[aria-label*="出發日期"], input[aria-label*="Depart"]'
      ).first();

      if (await dateInput.isVisible({ timeout: 3000 })) {
        await dateInput.click();
        await humanDelay(page, 500, 1000);
      }
    } else {
      const dateInput = page.locator(
        '#search-flight-date-picker--return, input[name*="return"], input[aria-label*="回程日期"], input[aria-label*="Return"]'
      ).first();

      if (await dateInput.isVisible({ timeout: 3000 })) {
        await dateInput.click();
        await humanDelay(page, 500, 1000);
      }
    }

    // 嘗試在日曆中選擇日期
    const dateValue = `${year}-${month}-${day}`;
    const calendarDay = page.locator(
      `[data-date="${dateValue}"], [data-day="${parseInt(day)}"][data-month="${parseInt(month) - 1}"][data-year="${year}"], button:has-text("${parseInt(day)}")[aria-label*="${year}"]`
    ).first();

    if (await calendarDay.isVisible({ timeout: 3000 })) {
      await calendarDay.click();
      await humanDelay(page, 300, 600);
      logger.info(`[阿聯酋] 日期已透過日曆選擇: ${type} = ${dateStr}`);
      return;
    }

    // 備用方案：透過 JavaScript 設定值
    await page.evaluate(({ dateVal, dateType }) => {
      const selectors = dateType === "depart"
        ? ['#search-flight-date-picker--depart', 'input[name*="depart"]']
        : ['#search-flight-date-picker--return', 'input[name*="return"]'];

      for (const sel of selectors) {
        const input = document.querySelector(sel);
        if (input) {
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, "value"
          ).set;
          nativeInputValueSetter.call(input, dateVal);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          break;
        }
      }
    }, { dateVal: `${day}/${month}/${year}`, dateType: type });

    logger.info(`[阿聯酋] 日期已透過 JS 設定: ${type} = ${dateStr}`);
  } catch (error) {
    logger.warn(`[阿聯酋] 日期設定可能失敗: ${type}`, { error: error.message });
  }

  await humanDelay(page, 300, 600);
}

/**
 * 設定旅客人數
 */
async function setPassengerCount(page, adults) {
  try {
    // 點開旅客選擇器
    const passengerToggle = page.locator(
      '[class*="passenger"] button, [aria-label*="旅客"], [aria-label*="passenger"], button:has-text("旅客"), .js-passenger'
    ).first();

    if (await passengerToggle.isVisible({ timeout: 3000 })) {
      await passengerToggle.click();
      await humanDelay(page, 500, 1000);

      // 點擊 + 按鈕增加成人
      const plusBtn = page.locator(
        'button[aria-label*="增加成人"], button[aria-label*="Add adult"], button[aria-label*="increase"][aria-label*="adult"], .js-adult-plus'
      ).first();

      for (let i = 1; i < adults; i++) {
        if (await plusBtn.isVisible({ timeout: 2000 })) {
          await plusBtn.click();
          await humanDelay(page, 200, 400);
        }
      }
    }
  } catch {
    logger.debug("[阿聯酋] 旅客人數設定失敗，使用預設值");
  }
}

/**
 * 等待結果頁載入
 */
async function waitForResults(page) {
  // 嘗試多種結果頁的標誌性元素
  const resultSelectors = [
    '[class*="flight-card"]',
    '[class*="FlightCard"]',
    '[class*="flight-result"]',
    '[class*="search-result"]',
    '[class*="flight-list"]',
    '[data-test*="flight"]',
    '[class*="bound"]',
    'table[class*="flight"]',
  ];

  for (const selector of resultSelectors) {
    try {
      await page.waitForSelector(selector, { timeout: 10000 });
      logger.info(`[阿聯酋] 找到結果元素: ${selector}`);
      return;
    } catch {}
  }

  // 最後備用：等待頁面穩定
  await page.waitForTimeout(5000);
  logger.warn("[阿聯酋] 未找到明確結果元素，嘗試解析當前頁面");
}

/**
 * 解析航班搜尋結果（通用方式）
 *
 * 使用文字模式匹配來提取航班資訊：
 * - 價格模式：TWD/NT$ + 數字，或大數字
 * - 時間模式：HH:MM
 * - 航班號模式：EK + 3-4位數字
 */
async function parseFlightResults(page) {
  const flights = [];

  try {
    const flightData = await page.evaluate(() => {
      const results = [];

      // 策略 1：尋找有結構的航班卡片
      const cardSelectors = [
        '[class*="flight-card"]',
        '[class*="FlightCard"]',
        '[class*="flight-result"]',
        '[class*="search-result"]',
        '[class*="flight-list"] > *',
        '[class*="bound"]',
        'tr[class*="flight"]',
      ];

      let cards = [];
      for (const sel of cardSelectors) {
        const found = document.querySelectorAll(sel);
        if (found.length > 0) {
          cards = found;
          break;
        }
      }

      if (cards.length > 0) {
        for (const card of cards) {
          const text = card.textContent || "";

          // 提取航班號（EK + 數字）
          const fnMatch = text.match(/EK\s*\d{2,4}/);
          const flightNumber = fnMatch ? fnMatch[0].replace(/\s+/g, "") : "";

          // 提取時間（HH:MM 格式）
          const timeMatches = text.match(/\d{1,2}:\d{2}/g) || [];
          const departTime = timeMatches[0] || "--:--";
          const arriveTime = timeMatches[1] || "--:--";

          // 提取飛行時間（Xh XXm 或 X小時X分鐘）
          const durMatch = text.match(/(\d+)\s*[hH時]\s*(\d+)?\s*[mM分]?/) || [];
          const duration = durMatch[0] || "";

          // 提取價格
          const priceMatch = text.match(/(?:TWD|NT\$|NTD)\s*[\d,]+/) || text.match(/[\d,]{4,}/g);
          let price = 0;
          if (priceMatch) {
            const priceStr = (Array.isArray(priceMatch) ? priceMatch[0] : priceMatch);
            price = parseInt(priceStr.replace(/[^0-9]/g, "")) || 0;
          }

          // 提取轉機資訊
          const stopsMatch = text.match(/(\d+)\s*(?:stop|轉機|經停)/) || text.match(/直飛|Direct|Non-?stop/i);
          let stops = 0;
          if (stopsMatch) {
            if (/直飛|Direct|Non-?stop/i.test(stopsMatch[0])) {
              stops = 0;
            } else {
              stops = parseInt(stopsMatch[1]) || 1;
            }
          }

          // 提取艙等
          let cabinClass = "ECONOMY";
          let cabinName = "經濟艙";
          if (/商務|Business/i.test(text)) {
            cabinClass = "BUSINESS";
            cabinName = "商務艙";
          } else if (/頭等|First/i.test(text)) {
            cabinClass = "FIRST";
            cabinName = "頭等艙";
          } else if (/豪華經濟|Premium/i.test(text)) {
            cabinClass = "PREMIUM_ECONOMY";
            cabinName = "豪華經濟艙";
          }

          // 提取剩餘座位
          const seatsMatch = text.match(/(\d+)\s*(?:seats?|個座位|席)/i);
          const seatsLeft = seatsMatch ? seatsMatch[0] : "";

          if (flightNumber || price > 0) {
            results.push({
              flightNumber: flightNumber || "EK???",
              departTime,
              arriveTime,
              duration,
              price,
              stops,
              cabinClass,
              cabinName,
              seatsLeft,
            });
          }
        }
      }

      // 策略 2：如果沒有找到結構化卡片，嘗試從整個頁面提取
      if (results.length === 0) {
        const body = document.body?.textContent || "";

        // 提取所有 EK 航班號
        const allFlightNums = body.match(/EK\s*\d{2,4}/g) || [];
        const allTimes = body.match(/\d{1,2}:\d{2}/g) || [];
        const allPrices = body.match(/(?:TWD|NT\$|NTD)\s*[\d,]+/g) || [];

        const count = Math.min(allFlightNums.length, 10);
        for (let i = 0; i < count; i++) {
          results.push({
            flightNumber: allFlightNums[i]?.replace(/\s+/g, "") || "EK???",
            departTime: allTimes[i * 2] || "--:--",
            arriveTime: allTimes[i * 2 + 1] || "--:--",
            duration: "",
            price: allPrices[i] ? parseInt(allPrices[i].replace(/[^0-9]/g, "")) : 0,
            stops: 0,
            cabinClass: "ECONOMY",
            cabinName: "經濟艙",
            seatsLeft: "",
          });
        }
      }

      return results;
    });

    for (const data of flightData) {
      if (data.price > 0 || data.flightNumber !== "EK???") {
        flights.push({
          flightNumber: data.flightNumber,
          departTime: data.departTime,
          arriveTime: data.arriveTime,
          duration: data.duration,
          price: data.price,
          currency: "TWD",
          stops: data.stops,
          cabinClass: data.cabinClass,
          cabinName: data.cabinName,
          seatsLeft: data.seatsLeft,
        });
      }
    }

    logger.info(`[阿聯酋] 解析到 ${flights.length} 筆票價`);
  } catch (error) {
    logger.error("[阿聯酋] 解析結果失敗", { error: error.message });
  }

  return flights;
}

/**
 * 產生阿聯酋航空訂票連結
 */
function getBookingUrl(params) {
  const { origin, destination, departDate, returnDate, adults = 1 } = params;
  const dep = departDate.replace(/-/g, "");
  const base = "https://www.emirates.com/tw/chinese/book/";
  if (returnDate) {
    const ret = returnDate.replace(/-/g, "");
    return `${base}?from=${origin}&to=${destination}&depart=${dep}&return=${ret}&pax=${adults}`;
  }
  return `${base}?from=${origin}&to=${destination}&depart=${dep}&pax=${adults}`;
}

module.exports = {
  AIRLINE,
  searchCash,
  searchMiles,
  getBookingUrl,
};
