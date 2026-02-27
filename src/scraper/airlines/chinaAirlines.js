// =============================================
// 華航 (China Airlines, CI) 爬蟲
//
// 目標網站：https://www.china-airlines.com/
// 功能：查詢現金票價 + 里程兌換票價
//
// 搜尋流程：
// 1. china-airlines.com 填寫表單
// 2. 跳轉 bookingportal.china-airlines.com（可能出現警告）
// 3. 跳轉 des-portal.china-airlines.com 顯示結果
//
// ⚠️ 重要：航空公司網站經常改版，
// selector 可能需要定期更新！
// 最後更新：2026-02-27
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
    await humanDelay(page, 2000, 3000);

    // 關閉 cookie 提示
    await dismissCookieBanner(page);

    // === 步驟 2：填寫搜尋表單 ===

    // 選擇來回 / 單程
    if (returnDate) {
      await page.locator("#Round-trip").click().catch(() => {});
    } else {
      await page.locator("#One-way").click().catch(() => {});
    }
    await humanDelay(page, 300, 800);

    // 填入出發地
    const originInput = page.locator("#From-booking");
    await originInput.click();
    await humanDelay(page, 200, 500);
    await originInput.fill("");
    await originInput.type(origin, { delay: 100 });
    await humanDelay(page, 1000, 2000);
    // 從下拉選單選擇
    const originSuggestion = page.locator(`#From-booking-suggestions li`).first();
    if (await originSuggestion.isVisible({ timeout: 5000 })) {
      await originSuggestion.click();
    } else {
      await page.keyboard.press("Enter");
    }
    await humanDelay(page);

    // 填入目的地
    const destInput = page.locator("#To-booking");
    await destInput.click();
    await humanDelay(page, 200, 500);
    await destInput.fill("");
    await destInput.type(destination, { delay: 100 });
    await humanDelay(page, 1000, 2000);
    const destSuggestion = page.locator(`#To-booking-suggestions li`).first();
    if (await destSuggestion.isVisible({ timeout: 5000 })) {
      await destSuggestion.click();
    } else {
      await page.keyboard.press("Enter");
    }
    await humanDelay(page);

    // 填入日期
    await fillDate(page, departDate, "depart");
    if (returnDate) {
      await fillDate(page, returnDate, "return");
    }

    // 填入人數
    if (adults > 1) {
      await setPassengerCount(page, adults);
    }

    // === 步驟 3：送出搜尋 ===
    const searchBtn = page.locator('a[type="submit"].btn-brand-pink');
    await searchBtn.click();
    logger.info("[華航] 已點擊搜尋，等待結果頁...");

    // === 步驟 4：處理跳轉與警告頁面 ===
    // 可能出現 bookingportal 的警告頁面（出發日期太近等）
    await handleWarningPage(page);

    // 等待結果頁載入（des-portal.china-airlines.com）
    await page.waitForSelector(".basic-flight-card-layout-top-section-container", {
      timeout: 45000,
    });
    await humanDelay(page, 1000, 2000);

    logger.info("[華航] 結果頁已載入");

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
    await page.goto(
      "https://www.china-airlines.com/tw/zh/booking/book-flights/flight-search?type=award",
      { waitUntil: "domcontentloaded" }
    );
    await humanDelay(page);

    // 步驟 3：填寫搜尋表單（類似現金票）
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
 * 關閉 cookie 提示
 */
async function dismissCookieBanner(page) {
  try {
    const cookieBtn = page.locator('a:has-text("我同意"), button:has-text("我同意"), button:has-text("接受")');
    if (await cookieBtn.isVisible({ timeout: 3000 })) {
      await cookieBtn.click();
      await humanDelay(page, 300, 600);
    }
  } catch {}
}

/**
 * 處理 bookingportal 的警告頁面（出發日期太近等）
 */
async function handleWarningPage(page) {
  try {
    // 等待跳轉到 bookingportal 或 des-portal
    await page.waitForURL(/bookingportal|des-portal/, { timeout: 15000 });
    await humanDelay(page, 1000, 2000);

    // 如果出現警告對話框，點「繼續」
    const continueBtn = page.locator('button:has-text("繼續"), a:has-text("繼續")');
    if (await continueBtn.isVisible({ timeout: 5000 })) {
      logger.info("[華航] 偵測到警告頁面，點擊繼續");
      await continueBtn.click();
      await humanDelay(page, 2000, 3000);
    }
  } catch {
    // 沒有警告頁面，直接跳到結果頁
  }
}

/**
 * 填入日期
 * 華航日期欄位 ID: #departureDate（格式 YYYY/MM/DD）
 */
async function fillDate(page, dateStr, type) {
  const [year, month, day] = dateStr.split("-");
  const formattedDate = `${year}/${month}/${day}`;

  if (type === "depart") {
    // 直接透過 JavaScript 設定日期值（最可靠的方式）
    await page.evaluate((dateVal) => {
      const input = document.querySelector("#departureDate");
      if (input) {
        // 用 Angular 的方式設定值
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, "value"
        ).set;
        nativeInputValueSetter.call(input, dateVal);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, formattedDate);
  } else {
    // 回程日期
    await page.evaluate((dateVal) => {
      const input = document.querySelector("#returnDate");
      if (input) {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, "value"
        ).set;
        nativeInputValueSetter.call(input, dateVal);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, formattedDate);
  }

  await humanDelay(page, 300, 600);
  logger.info(`[華航] 日期已設定: ${type} = ${formattedDate}`);
}

/**
 * 設定旅客人數
 */
async function setPassengerCount(page, adults) {
  try {
    // 點開旅客下拉選單
    const passengerDropdown = page.locator("#No-of-passengers, [class*='passenger'] .dropdown-toggle");
    if (await passengerDropdown.isVisible({ timeout: 3000 })) {
      await passengerDropdown.click();
      await humanDelay(page, 300, 600);

      // 點擊 + 按鈕增加成人人數
      const adultPlus = page.locator('.adult-count .plus, button[aria-label*="增加成人"]').first();
      for (let i = 1; i < adults; i++) {
        if (await adultPlus.isVisible({ timeout: 2000 })) {
          await adultPlus.click();
          await humanDelay(page, 200, 400);
        }
      }
    }
  } catch {
    logger.debug("[華航] 旅客人數設定失敗，使用預設值");
  }
}

/**
 * 解析航班搜尋結果頁面
 * 結果頁在 des-portal.china-airlines.com
 *
 * DOM 結構：
 * .basic-flight-card-layout-top-section-container  ← 每個航班卡片
 *   .bound-departure-datetime  ← 出發時間
 *   .bound-arrival-datetime    ← 抵達時間
 *   .duration-value            ← 飛行時間
 *   .flight-number             ← 航班編號
 *   .bound-nb-stop-container   ← 轉機資訊（有 .has-stops class 表示有轉機）
 *   button.flight-card-button-desktop-view  ← 票價按鈕
 *     .refx-fare-family-flight-card-name    ← 艙等名稱
 *     [data-amount]                         ← 價格數字
 */
async function parseFlightResults(page) {
  const flights = [];

  try {
    const flightData = await page.evaluate(() => {
      const cards = document.querySelectorAll(".basic-flight-card-layout-top-section-container");
      const results = [];

      for (const card of cards) {
        const depTime = card.querySelector(".bound-departure-datetime")?.textContent.trim() || "--:--";
        const arrTime = card.querySelector(".bound-arrival-datetime")?.textContent.trim() || "--:--";
        const depAirport = card.querySelector(".bound-departure-airport")?.textContent.trim() || "";
        const arrAirport = card.querySelector(".bound-arrival-airport")?.textContent.trim() || "";
        const duration = card.querySelector(".duration-value")?.textContent.trim() || "";
        const flightNums = [...card.querySelectorAll(".flight-number")].map((el) => el.textContent.trim());
        const flightNumber = flightNums.join(" / ");

        // 轉機判斷
        const stopContainer = card.querySelector(".bound-nb-stop-container");
        const hasStops = stopContainer?.classList.contains("has-stops");
        const stopCount = hasStops
          ? parseInt(stopContainer.querySelector(".nb-stop-shape")?.textContent.trim() || "1")
          : 0;

        // 座位餘量
        const seatsLeft = card.querySelector(".ribbon")?.textContent.trim() || "";

        // 各艙等票價
        const fareButtons = card.querySelectorAll("button.flight-card-button-desktop-view");
        const fares = [];
        fareButtons.forEach((btn) => {
          const name = btn.querySelector(".refx-fare-family-flight-card-name")?.textContent.trim() || "";
          const priceEl = btn.querySelector("[data-amount]");
          const price = priceEl ? parseInt(priceEl.getAttribute("data-amount")) : 0;
          const mixCabin = btn.querySelector('[class*="mix"]')?.textContent.trim() || "";
          fares.push({ name, price, mixCabin });
        });

        results.push({
          depTime, arrTime, depAirport, arrAirport,
          duration, flightNumber, stopCount, seatsLeft, fares,
        });
      }
      return results;
    });

    // 把每個航班的各艙等拆成獨立的 flight 記錄
    for (const data of flightData) {
      for (const fare of data.fares) {
        if (fare.price <= 0) continue;

        // 判斷艙等
        let cabinClass = "ECONOMY";
        if (fare.name.includes("商務")) cabinClass = "BUSINESS";
        else if (fare.name.includes("豪華經濟")) cabinClass = "PREMIUM_ECONOMY";

        flights.push({
          flightNumber: data.flightNumber,
          departTime: data.depTime,
          arriveTime: data.arrTime,
          duration: data.duration,
          price: fare.price,
          currency: "TWD",
          stops: data.stopCount,
          cabinClass,
          cabinName: fare.name + (fare.mixCabin ? `（${fare.mixCabin}）` : ""),
          seatsLeft: data.seatsLeft,
        });
      }
    }

    logger.info(`[華航] 解析到 ${flights.length} 筆票價（${flightData.length} 個航班）`);
  } catch (error) {
    logger.error("[華航] 解析結果失敗", { error: error.message });
  }

  return flights;
}

async function parseMilesResults(page) {
  // 里程票結果解析（需要登入後實際測試 DOM 結構）
  const flights = [];

  try {
    const cards = page.locator(".basic-flight-card-layout-top-section-container");
    const count = await cards.count();

    for (let i = 0; i < Math.min(count, 10); i++) {
      try {
        const card = cards.nth(i);
        const flightNum = await card.locator(".flight-number").first().textContent().catch(() => "CI???");
        const departTime = await card.locator(".bound-departure-datetime").textContent().catch(() => "--:--");
        const arriveTime = await card.locator(".bound-arrival-datetime").textContent().catch(() => "--:--");
        const milesText = await card.locator("[data-amount]").first().getAttribute("data-amount").catch(() => "0");

        flights.push({
          flightNumber: flightNum.trim(),
          departTime: departTime.trim(),
          arriveTime: arriveTime.trim(),
          miles: parseInt(milesText) || 0,
          taxes: 0,
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
