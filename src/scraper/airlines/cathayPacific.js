// =============================================
// 國泰航空 (Cathay Pacific, CX) 爬蟲
//
// 目標網站：https://www.cathaypacific.com/
// 搜尋頁面：https://www.cathaypacific.com/cx/zh_TW.html
//
// 使用通用方式：
// - 前往首頁，尋找訂票表單
// - 填寫出發地/目的地/日期
// - 點擊搜尋按鈕
// - 解析結果頁面
//
// ⚠️ 重要：航空公司網站經常改版，
// selector 可能需要定期更新！
// 最後更新：2026-02-27
// =============================================

const { createPage, closePage, humanDelay, takeScreenshot } = require("../browserManager");
const logger = require("../../utils/logger");
const { config } = require("../../config");

const AIRLINE = {
  code: "CX",
  name: "國泰",
  fullName: "國泰航空",
  baseUrl: "https://www.cathaypacific.com",
  bookingUrl: "https://www.cathaypacific.com/cx/zh_TW.html",
};

/**
 * 搜尋國泰航空現金票
 *
 * @param {Object} params
 * @param {string} params.origin       - "TPE"
 * @param {string} params.destination   - "HKG"
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
    logger.info(`[國泰] 開始搜尋現金票 ${origin}→${destination} ${departDate}`);

    // === 步驟 1：前往國泰航空首頁 ===
    await page.goto(AIRLINE.bookingUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(page, 2000, 3000);

    // 關閉 cookie 提示
    await dismissCookieBanner(page);

    // 關閉可能出現的彈窗
    await dismissPopups(page);

    // === 步驟 2：確保訂票表單可見 ===
    // 國泰首頁的訂票 widget 可能需要展開
    try {
      const bookingWidget = page.locator(
        '[class*="booking-widget"], [class*="BookingWidget"], [data-component*="booking"], #booking-widget'
      ).first();
      if (await bookingWidget.isVisible({ timeout: 3000 })) {
        await bookingWidget.click();
        await humanDelay(page, 500, 1000);
      }
    } catch {}

    // 確保在「航班」tab
    try {
      const flightTab = page.locator(
        'a:has-text("航班"), button:has-text("航班"), a:has-text("訂票"), [role="tab"]:has-text("Flight"), a:has-text("Book flights")'
      ).first();
      if (await flightTab.isVisible({ timeout: 3000 })) {
        await flightTab.click();
        await humanDelay(page, 500, 1000);
      }
    } catch {}

    // 選擇來回/單程
    if (!returnDate) {
      try {
        const oneWay = page.locator(
          'label:has-text("單程"), input[value*="one"], label:has-text("One-way"), label:has-text("One way"), [data-trip-type*="one"]'
        ).first();
        if (await oneWay.isVisible({ timeout: 3000 })) {
          await oneWay.click();
          await humanDelay(page, 300, 600);
        }
      } catch {}
    }

    // === 步驟 3：填寫搜尋表單 ===

    // 填入出發地
    const originInput = page.locator(
      'input[placeholder*="出發"], input[placeholder*="From"], input[aria-label*="出發"], input[aria-label*="Origin"], input[aria-label*="From"], input[name*="origin"], input[id*="origin"], input[id*="departure"], input[data-testid*="origin"]'
    ).first();
    await originInput.click();
    await humanDelay(page, 300, 600);
    await originInput.fill("");
    await originInput.type(origin, { delay: 100 });
    await humanDelay(page, 1500, 2500);

    // 從下拉選單選擇
    const originOption = page.locator(
      `[role="option"]:has-text("${origin}"), li:has-text("${origin}"), [class*="suggestion"]:has-text("${origin}"), [class*="autocomplete"]:has-text("${origin}"), [class*="dropdown"] li:has-text("${origin}")`
    ).first();
    if (await originOption.isVisible({ timeout: 5000 })) {
      await originOption.click();
    } else {
      await page.keyboard.press("Enter");
    }
    await humanDelay(page);

    // 填入目的地
    const destInput = page.locator(
      'input[placeholder*="目的"], input[placeholder*="To"], input[placeholder*="Arrive"], input[aria-label*="目的"], input[aria-label*="Destination"], input[aria-label*="To"], input[name*="destination"], input[id*="destination"], input[id*="arrival"], input[data-testid*="destination"]'
    ).first();
    await destInput.click();
    await humanDelay(page, 300, 600);
    await destInput.fill("");
    await destInput.type(destination, { delay: 100 });
    await humanDelay(page, 1500, 2500);

    // 從下拉選單選擇
    const destOption = page.locator(
      `[role="option"]:has-text("${destination}"), li:has-text("${destination}"), [class*="suggestion"]:has-text("${destination}"), [class*="autocomplete"]:has-text("${destination}"), [class*="dropdown"] li:has-text("${destination}")`
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

    // === 步驟 4：送出搜尋 ===
    const searchBtn = page.locator(
      'button:has-text("搜尋"), button:has-text("Search"), button:has-text("查詢航班"), button[type="submit"], a.btn:has-text("搜尋"), a.btn:has-text("Search")'
    ).first();
    await searchBtn.click();
    logger.info("[國泰] 已點擊搜尋，等待結果頁...");

    // === 步驟 5：等待結果頁載入 ===
    try {
      await page.waitForURL(/cathaypacific\.com.*(book|flight|search|result|availability)/i, { timeout: 45000 });
    } catch {
      logger.info("[國泰] URL 未跳轉，嘗試等待頁面內容...");
    }
    await humanDelay(page, 3000, 5000);

    // 等待結果頁的航班卡片出現
    await waitForResults(page);

    logger.info("[國泰] 結果頁已載入");

    // 截圖（除錯用）
    if (config.server.nodeEnv === "development") {
      await takeScreenshot(page, "cx-results");
    }

    // === 步驟 6：解析結果 ===
    const flights = await parseFlightResults(page);

    if (flights.length === 0) {
      return { success: true, flights: [], message: "國泰查無此航線或日期的航班" };
    }

    return {
      success: true,
      airline: AIRLINE,
      flights: flights.map((f) => ({ ...f, airline: "CX", airlineName: "國泰", type: "cash" })),
    };
  } catch (error) {
    logger.error("[國泰] 現金票搜尋失敗", { error: error.message });
    if (page && config.server.nodeEnv === "development") {
      await takeScreenshot(page, "cx-error");
    }
    return { success: false, error: `國泰搜尋失敗：${error.message}` };
  } finally {
    await closePage(page);
  }
}

/**
 * 搜尋國泰航空里程票（開發中）
 */
async function searchMiles(params) {
  return { success: false, error: "國泰里程票爬蟲開發中" };
}

// === 內部輔助函式 ===

/**
 * 關閉 cookie 提示
 */
async function dismissCookieBanner(page) {
  try {
    const cookieBtn = page.locator(
      'button:has-text("接受"), button:has-text("Accept"), button:has-text("我同意"), button:has-text("同意"), button[id*="cookie"], [class*="cookie"] button, [class*="consent"] button'
    ).first();
    if (await cookieBtn.isVisible({ timeout: 3000 })) {
      await cookieBtn.click();
      await humanDelay(page, 300, 600);
    }
  } catch {}
}

/**
 * 關閉彈窗
 */
async function dismissPopups(page) {
  try {
    const closeBtn = page.locator(
      '.modal-close, .popup-close, button[aria-label="Close"], button[aria-label="關閉"], [class*="modal"] button.close, [class*="overlay"] button.close, [class*="dialog"] button[class*="close"]'
    ).first();
    if (await closeBtn.isVisible({ timeout: 3000 })) {
      await closeBtn.click();
      await humanDelay(page, 300, 600);
    }
  } catch {}
}

/**
 * 填入日期
 * 嘗試多種方式設定日期
 */
async function fillDate(page, dateStr, type) {
  const [year, month, day] = dateStr.split("-");

  try {
    // 嘗試找到日期輸入欄位
    const dateSelectors = type === "depart"
      ? [
          'input[name*="depart"]', 'input[id*="depart"]',
          'input[aria-label*="出發日期"]', 'input[aria-label*="Depart"]',
          'input[placeholder*="出發"]', 'input[placeholder*="Depart"]',
          '[data-testid*="depart"] input', '[data-field*="depart"] input',
        ]
      : [
          'input[name*="return"]', 'input[id*="return"]',
          'input[aria-label*="回程日期"]', 'input[aria-label*="Return"]',
          'input[placeholder*="回程"]', 'input[placeholder*="Return"]',
          '[data-testid*="return"] input', '[data-field*="return"] input',
        ];

    let dateInput = null;
    for (const sel of dateSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
        dateInput = el;
        break;
      }
    }

    if (dateInput) {
      await dateInput.click();
      await humanDelay(page, 500, 1000);
    }

    // 嘗試在日曆中選擇日期
    const dateValue = `${year}-${month}-${day}`;
    const paddedDay = String(parseInt(day));
    const calendarDay = page.locator(
      `[data-date="${dateValue}"], [data-value="${dateValue}"], td[data-day="${paddedDay}"][data-month="${parseInt(month) - 1}"], button[aria-label*="${paddedDay}"][aria-label*="${year}"], .calendar-day:has-text("${paddedDay}")`
    ).first();

    if (await calendarDay.isVisible({ timeout: 3000 })) {
      await calendarDay.click();
      await humanDelay(page, 300, 600);
      logger.info(`[國泰] 日期已透過日曆選擇: ${type} = ${dateStr}`);
      return;
    }

    // 備用方案：透過 JavaScript 設定值
    await page.evaluate(({ dateVal, formattedDate, dateType }) => {
      const selectors = dateType === "depart"
        ? ['input[name*="depart"]', 'input[id*="depart"]']
        : ['input[name*="return"]', 'input[id*="return"]'];

      for (const sel of selectors) {
        const input = document.querySelector(sel);
        if (input) {
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, "value"
          ).set;
          nativeInputValueSetter.call(input, formattedDate);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          break;
        }
      }
    }, { dateVal: dateStr, formattedDate: `${day}/${month}/${year}`, dateType: type });

    logger.info(`[國泰] 日期已透過 JS 設定: ${type} = ${dateStr}`);
  } catch (error) {
    logger.warn(`[國泰] 日期設定可能失敗: ${type}`, { error: error.message });
  }

  await humanDelay(page, 300, 600);
}

/**
 * 設定旅客人數
 */
async function setPassengerCount(page, adults) {
  try {
    const passengerToggle = page.locator(
      '[class*="passenger"] button, button[aria-label*="旅客"], button[aria-label*="passenger"], button:has-text("旅客"), button:has-text("Passenger"), [class*="pax"] button, [data-testid*="passenger"] button'
    ).first();

    if (await passengerToggle.isVisible({ timeout: 3000 })) {
      await passengerToggle.click();
      await humanDelay(page, 500, 1000);

      const plusBtn = page.locator(
        'button[aria-label*="增加成人"], button[aria-label*="Add adult"], button[aria-label*="increase"][aria-label*="adult"], [class*="adult"] button[class*="plus"], [class*="adult"] button[class*="increase"], [class*="adult"] button:has-text("+")'
      ).first();

      for (let i = 1; i < adults; i++) {
        if (await plusBtn.isVisible({ timeout: 2000 })) {
          await plusBtn.click();
          await humanDelay(page, 200, 400);
        }
      }
    }
  } catch {
    logger.debug("[國泰] 旅客人數設定失敗，使用預設值");
  }
}

/**
 * 等待結果頁載入
 */
async function waitForResults(page) {
  const resultSelectors = [
    '[class*="flight-card"]',
    '[class*="FlightCard"]',
    '[class*="flight-result"]',
    '[class*="search-result"]',
    '[class*="flight-list"]',
    '[class*="flight-row"]',
    '[data-test*="flight"]',
    '[data-testid*="flight"]',
    '[class*="bound"]',
    '[class*="itinerary"]',
    '[class*="journey"]',
    'table[class*="flight"]',
  ];

  for (const selector of resultSelectors) {
    try {
      await page.waitForSelector(selector, { timeout: 10000 });
      logger.info(`[國泰] 找到結果元素: ${selector}`);
      return;
    } catch {}
  }

  await page.waitForTimeout(5000);
  logger.warn("[國泰] 未找到明確結果元素，嘗試解析當前頁面");
}

/**
 * 解析航班搜尋結果（通用方式）
 *
 * 使用文字模式匹配來提取航班資訊：
 * - 價格模式：TWD/NT$/HKD + 數字
 * - 時間模式：HH:MM
 * - 航班號模式：CX/KA + 3-4位數字
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
        '[class*="flight-row"]',
        '[class*="itinerary"]',
        '[class*="journey"]',
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

          // 提取航班號（CX 或 KA + 數字）
          const fnMatch = text.match(/(?:CX|KA)\s*\d{2,4}/);
          const flightNumber = fnMatch ? fnMatch[0].replace(/\s+/g, "") : "";

          // 提取時間
          const timeMatches = text.match(/\d{1,2}:\d{2}/g) || [];
          const departTime = timeMatches[0] || "--:--";
          const arriveTime = timeMatches[1] || "--:--";

          // 提取飛行時間
          const durMatch = text.match(/(\d+)\s*[hH時]\s*(\d+)?\s*[mM分]?/) || [];
          const duration = durMatch[0] || "";

          // 提取價格
          const priceMatch = text.match(/(?:TWD|NT\$|NTD|HKD)\s*[\d,]+/) || text.match(/[\d,]{4,}/g);
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
              flightNumber: flightNumber || "CX???",
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

      // 策略 2：從整頁提取
      if (results.length === 0) {
        const body = document.body?.textContent || "";

        const allFlightNums = body.match(/(?:CX|KA)\s*\d{2,4}/g) || [];
        const allTimes = body.match(/\d{1,2}:\d{2}/g) || [];
        const allPrices = body.match(/(?:TWD|NT\$|NTD|HKD)\s*[\d,]+/g) || [];

        const count = Math.min(allFlightNums.length, 10);
        for (let i = 0; i < count; i++) {
          results.push({
            flightNumber: allFlightNums[i]?.replace(/\s+/g, "") || "CX???",
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
      if (data.price > 0 || data.flightNumber !== "CX???") {
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

    logger.info(`[國泰] 解析到 ${flights.length} 筆票價`);
  } catch (error) {
    logger.error("[國泰] 解析結果失敗", { error: error.message });
  }

  return flights;
}

/**
 * 產生國泰航空訂票連結
 */
function getBookingUrl(params) {
  const { origin, destination, departDate, returnDate, adults = 1 } = params;
  const base = "https://www.cathaypacific.com/cx/zh_TW/book-a-trip/flight-search.html";
  const qs = new URLSearchParams({
    origin,
    destination,
    departureDate: departDate,
    ...(returnDate && { returnDate }),
    adults: String(adults),
  });
  return `${base}?${qs}`;
}

module.exports = {
  AIRLINE,
  searchCash,
  searchMiles,
  getBookingUrl,
};
