// =============================================
// 華航 (China Airlines, CI) 爬蟲
//
// 目標網站：https://www.china-airlines.com/
// 功能：查詢現金票價 + 里程兌換票價
//
// ⚠️ 重要：航空公司網站經常改版，
// selector 可能需要定期更新！
// =============================================

const { createPage, closePage, humanDelay, waitAndRetry, takeScreenshot } = require("../browserManager");
const logger = require("../../utils/logger");
const { config } = require("../../config");

const AIRLINE = {
  code: "CI",
  name: "華航",
  fullName: "中華航空",
  baseUrl: "https://www.china-airlines.com",
  bookingUrl: "https://www.china-airlines.com/tw/zh/booking/book-flights/flight-search",
};

/**
 * 搜尋華航現金票
 *
 * @param {Object} params
 * @param {string} params.origin       - "TPE"
 * @param {string} params.destination   - "NRT"
 * @param {string} params.departDate    - "2025-03-15"
 * @param {string} params.returnDate    - "2025-03-20" (optional)
 * @param {number} params.adults        - 1
 * @param {string} params.cabinClass    - "ECONOMY"
 * @returns {Object} { success, flights, error }
 */
async function searchCash(params) {
  const { origin, destination, departDate, returnDate, adults = 1 } = params;
  let page = null;

  try {
    page = await createPage();
    logger.info(`[華航] 開始搜尋現金票 ${origin}→${destination} ${departDate}`);

    // === 步驟 1：前往華航訂票頁面 ===
    await page.goto(AIRLINE.bookingUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(page);

    // 關閉可能出現的 cookie 提示或彈窗
    try {
      const cookieBtn = page.locator('button:has-text("接受"), button:has-text("同意"), .cookie-accept');
      if (await cookieBtn.isVisible({ timeout: 3000 })) {
        await cookieBtn.click();
        await humanDelay(page);
      }
    } catch {}

    // === 步驟 2：填寫搜尋表單 ===

    // 選擇來回 / 單程
    if (returnDate) {
      // 預設通常就是來回
      const roundTrip = page.locator('[data-value="roundTrip"], #roundTrip, input[value="RT"]');
      if (await roundTrip.isVisible({ timeout: 3000 })) {
        await roundTrip.click();
      }
    } else {
      const oneWay = page.locator('[data-value="oneWay"], #oneWay, input[value="OW"]');
      if (await oneWay.isVisible({ timeout: 3000 })) {
        await oneWay.click();
      }
    }
    await humanDelay(page, 300, 800);

    // 填入出發地
    const originInput = page.locator(
      '#departureCity, input[name="origin"], input[placeholder*="出發"], input[aria-label*="出發"]'
    );
    await originInput.click();
    await humanDelay(page, 200, 500);
    await originInput.fill("");
    await originInput.type(origin, { delay: 100 });
    await humanDelay(page, 1000, 2000);
    // 從下拉選單選擇
    const originOption = page.locator(
      `.suggestion-item:has-text("${origin}"), .dropdown-item:has-text("${origin}"), li:has-text("${origin}")`
    ).first();
    if (await originOption.isVisible({ timeout: 5000 })) {
      await originOption.click();
    } else {
      await page.keyboard.press("Enter");
    }
    await humanDelay(page);

    // 填入目的地
    const destInput = page.locator(
      '#arrivalCity, input[name="destination"], input[placeholder*="目的"], input[aria-label*="目的"]'
    );
    await destInput.click();
    await humanDelay(page, 200, 500);
    await destInput.fill("");
    await destInput.type(destination, { delay: 100 });
    await humanDelay(page, 1000, 2000);
    const destOption = page.locator(
      `.suggestion-item:has-text("${destination}"), .dropdown-item:has-text("${destination}"), li:has-text("${destination}")`
    ).first();
    if (await destOption.isVisible({ timeout: 5000 })) {
      await destOption.click();
    } else {
      await page.keyboard.press("Enter");
    }
    await humanDelay(page);

    // 填入日期（這部分最複雜，各網站日期選擇器不同）
    await fillDate(page, departDate, "depart");
    if (returnDate) {
      await fillDate(page, returnDate, "return");
    }

    // 填入人數
    if (adults > 1) {
      await setPassengerCount(page, adults);
    }

    // === 步驟 3：送出搜尋 ===
    const searchBtn = page.locator(
      'button:has-text("搜尋"), button:has-text("查詢"), button[type="submit"].search-btn, .btn-search'
    );
    await searchBtn.click();

    // === 步驟 4：等待結果載入 ===
    logger.info("[華航] 等待搜尋結果...");

    // 等待結果或錯誤訊息出現
    const resultLoaded = await Promise.race([
      waitAndRetry(page, '.flight-result, .flight-card, .flight-list, [class*="flightResult"]', { timeout: 30000 }),
      waitAndRetry(page, '.no-result, .error-message, [class*="noFlight"]', { timeout: 30000 }),
    ]);

    // 截圖（除錯用）
    if (config.server.nodeEnv === "development") {
      await takeScreenshot(page, "ci-results");
    }

    // === 步驟 5：解析結果 ===
    const flights = await parseFlightResults(page);

    if (flights.length === 0) {
      return { success: true, flights: [], message: "華航查無此航線或日期的航班" };
    }

    return {
      success: true,
      airline: AIRLINE,
      flights: flights.map((f) => ({ ...f, airline: "CI", airlineName: "華航", type: "cash" })),
    };
  } catch (error) {
    logger.error("[華航] 現金票搜尋失敗", { error: error.message });
    if (page && config.server.nodeEnv === "development") {
      await takeScreenshot(page, "ci-error");
    }
    return { success: false, error: `華航搜尋失敗：${error.message}` };
  } finally {
    await closePage(page);
  }
}

/**
 * 搜尋華航里程票
 * 需要先登入華航會員帳號
 */
async function searchMiles(params) {
  const account = config.mileageAccounts.CI;

  if (!account.id || !account.password) {
    return {
      success: false,
      error: "未設定華航會員帳號，無法查詢里程票。請在 .env 設定 CI_MEMBER_ID 和 CI_MEMBER_PASSWORD",
    };
  }

  let page = null;

  try {
    page = await createPage();
    logger.info(`[華航里程] 開始搜尋 ${params.origin}→${params.destination}`);

    // 步驟 1：登入華航會員
    await page.goto("https://www.china-airlines.com/tw/zh/member/login", {
      waitUntil: "domcontentloaded",
    });
    await humanDelay(page);

    const memberIdInput = page.locator('#memberId, input[name="memberId"], input[placeholder*="會員"]');
    await memberIdInput.fill(account.id);
    await humanDelay(page, 300, 600);

    const passwordInput = page.locator('#password, input[name="password"], input[type="password"]');
    await passwordInput.fill(account.password);
    await humanDelay(page, 300, 600);

    const loginBtn = page.locator('button:has-text("登入"), button[type="submit"]');
    await loginBtn.click();
    await page.waitForTimeout(3000);

    // 步驟 2：前往里程兌換頁面
    // 華航的里程兌換頁面 URL（需要根據實際情況調整）
    await page.goto(
      "https://www.china-airlines.com/tw/zh/booking/book-flights/flight-search?type=award",
      { waitUntil: "domcontentloaded" }
    );
    await humanDelay(page);

    // 步驟 3：填寫搜尋表單（類似現金票，但在里程模式下）
    // ... (與 searchCash 類似的表單填寫邏輯)

    // 步驟 4：解析里程票結果
    const flights = await parseMilesResults(page);

    return {
      success: true,
      airline: AIRLINE,
      flights: flights.map((f) => ({ ...f, airline: "CI", airlineName: "華航", type: "miles" })),
    };
  } catch (error) {
    logger.error("[華航里程] 搜尋失敗", { error: error.message });
    return { success: false, error: `華航里程票搜尋失敗：${error.message}` };
  } finally {
    await closePage(page);
  }
}

// === 內部輔助函式 ===

/**
 * 填入日期（處理各種日期選擇器）
 * 這是最棘手的部分，因為每個網站的日期選擇器都不一樣
 */
async function fillDate(page, dateStr, type) {
  const [year, month, day] = dateStr.split("-");

  // 嘗試直接填入 input
  const dateInput = page.locator(
    type === "depart"
      ? '#departureDate, input[name="departureDate"], input[aria-label*="出發日期"]'
      : '#returnDate, input[name="returnDate"], input[aria-label*="回程日期"]'
  );

  try {
    await dateInput.click();
    await humanDelay(page, 500, 1000);

    // 嘗試在日曆上點擊正確的日期
    // 先導航到正確的月份
    const targetMonth = parseInt(month);
    const targetYear = parseInt(year);

    // 點「下個月」按鈕直到到達目標月份
    for (let i = 0; i < 12; i++) {
      const currentMonth = await page.locator(".calendar-month, .month-title, [class*='monthYear']").first().textContent().catch(() => "");
      if (currentMonth.includes(`${targetYear}`) && currentMonth.includes(`${targetMonth}`)) {
        break;
      }
      const nextBtn = page.locator('.next-month, .calendar-next, button[aria-label="Next month"]').first();
      if (await nextBtn.isVisible({ timeout: 1000 })) {
        await nextBtn.click();
        await humanDelay(page, 300, 600);
      } else {
        break;
      }
    }

    // 點擊日期
    const dayNum = parseInt(day);
    const dayCell = page.locator(
      `td[data-day="${dayNum}"], .day-cell:has-text("${dayNum}"), button:has-text("${dayNum}")`
    ).first();
    if (await dayCell.isVisible({ timeout: 3000 })) {
      await dayCell.click();
    } else {
      // fallback：直接輸入
      await dateInput.fill(dateStr);
    }
  } catch {
    // 最後手段：嘗試直接填入
    try {
      await dateInput.fill(`${year}/${month}/${day}`);
    } catch {
      logger.warn(`[華航] 日期填入失敗: ${dateStr}`);
    }
  }
  await humanDelay(page, 300, 800);
}

async function setPassengerCount(page, adults) {
  try {
    const adultPlus = page.locator(
      '.passenger-adult .plus, button[aria-label*="增加成人"], .pax-adult .btn-plus'
    ).first();
    for (let i = 1; i < adults; i++) {
      if (await adultPlus.isVisible({ timeout: 3000 })) {
        await adultPlus.click();
        await humanDelay(page, 200, 400);
      }
    }
  } catch {
    logger.debug("[華航] 旅客人數設定失敗，使用預設值");
  }
}

/**
 * 解析航班搜尋結果頁面
 * ⚠️ 這裡的 selector 需要根據實際網站調整
 */
async function parseFlightResults(page) {
  const flights = [];

  try {
    // 取得所有航班卡片
    const cards = page.locator(
      '.flight-result, .flight-card, [class*="flightResult"], [class*="flight-item"]'
    );
    const count = await cards.count();

    for (let i = 0; i < Math.min(count, 10); i++) {
      try {
        const card = cards.nth(i);

        // 嘗試提取航班資訊（selector 需要根據實際頁面調整）
        const flightNum = await card.locator('.flight-number, [class*="flightNo"]').textContent().catch(() => "CI???");
        const departTime = await card.locator('.depart-time, [class*="departTime"]').textContent().catch(() => "--:--");
        const arriveTime = await card.locator('.arrive-time, [class*="arriveTime"]').textContent().catch(() => "--:--");
        const duration = await card.locator('.duration, [class*="duration"]').textContent().catch(() => "");
        const priceText = await card.locator('.price, [class*="price"], .fare').textContent().catch(() => "0");

        // 解析價格（去除非數字字元）
        const price = parseInt(priceText.replace(/[^0-9]/g, "")) || 0;

        // 判斷是否直飛
        const stopsText = await card.locator('.stops, [class*="stop"]').textContent().catch(() => "直飛");
        const stops = stopsText.includes("直飛") || stopsText.includes("0") ? 0 : parseInt(stopsText.replace(/[^0-9]/g, "")) || 1;

        flights.push({
          flightNumber: flightNum.trim(),
          departTime: departTime.trim(),
          arriveTime: arriveTime.trim(),
          duration: duration.trim(),
          price,
          currency: "TWD",
          stops,
          cabinClass: "ECONOMY",
        });
      } catch (e) {
        logger.debug(`[華航] 解析第 ${i + 1} 筆航班失敗`, { error: e.message });
      }
    }
  } catch (error) {
    logger.error("[華航] 解析結果失敗", { error: error.message });
  }

  return flights;
}

async function parseMilesResults(page) {
  // 里程票結果解析（結構類似，但價格欄位是里程數 + 稅金）
  const flights = [];

  try {
    const cards = page.locator('.flight-result, .flight-card, [class*="award"]');
    const count = await cards.count();

    for (let i = 0; i < Math.min(count, 10); i++) {
      try {
        const card = cards.nth(i);
        const flightNum = await card.locator('.flight-number').textContent().catch(() => "CI???");
        const departTime = await card.locator('.depart-time').textContent().catch(() => "--:--");
        const arriveTime = await card.locator('.arrive-time').textContent().catch(() => "--:--");
        const milesText = await card.locator('.miles, [class*="mile"]').textContent().catch(() => "0");
        const taxText = await card.locator('.tax, [class*="tax"]').textContent().catch(() => "0");

        flights.push({
          flightNumber: flightNum.trim(),
          departTime: departTime.trim(),
          arriveTime: arriveTime.trim(),
          miles: parseInt(milesText.replace(/[^0-9]/g, "")) || 0,
          taxes: parseInt(taxText.replace(/[^0-9]/g, "")) || 0,
          currency: "TWD",
          cabinClass: "ECONOMY",
        });
      } catch {}
    }
  } catch {}

  return flights;
}

// 產生華航官網的直接訂票連結
function getBookingUrl(params) {
  const { origin, destination, departDate, returnDate, adults = 1 } = params;
  const base = "https://www.china-airlines.com/tw/zh/booking/book-flights/flight-search";
  const qs = new URLSearchParams({
    origin,
    destination,
    departureDate: departDate,
    ...(returnDate && { returnDate }),
    adults: String(adults),
    cabinClass: "ECONOMY",
  });
  return `${base}?${qs}`;
}

module.exports = {
  AIRLINE,
  searchCash,
  searchMiles,
  getBookingUrl,
};
