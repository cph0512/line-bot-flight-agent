// =============================================
// 星宇航空 (STARLUX, JX) 爬蟲
// 目標：https://www.starlux-airlines.com/
// =============================================

const { createPage, closePage, humanDelay } = require("../browserManager");
const logger = require("../../utils/logger");
const { config } = require("../../config");

const AIRLINE = {
  code: "JX",
  name: "星宇",
  fullName: "星宇航空",
  baseUrl: "https://www.starlux-airlines.com",
  bookingUrl: "https://www.starlux-airlines.com/zh-TW/booking",
};

async function searchCash(params) {
  const { origin, destination, departDate, returnDate, adults = 1 } = params;
  let page = null;

  try {
    page = await createPage();
    logger.info(`[星宇] 開始搜尋 ${origin}→${destination} ${departDate}`);

    await page.goto(AIRLINE.bookingUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(page);

    // 星宇官網表單填寫邏輯
    // 注意：星宇是比較新的航空公司，官網通常是 React/Vue SPA
    // selector 需要根據實際 DOM 調整

    // 出發地
    const originInput = page.locator('input[placeholder*="出發"], input[aria-label*="出發"], #origin');
    await originInput.click();
    await originInput.type(origin, { delay: 80 });
    await humanDelay(page, 1000, 2000);
    await page.locator(`[role="option"]:has-text("${origin}"), li:has-text("${origin}")`).first().click().catch(() => page.keyboard.press("Enter"));
    await humanDelay(page);

    // 目的地
    const destInput = page.locator('input[placeholder*="目的"], input[aria-label*="目的"], #destination');
    await destInput.click();
    await destInput.type(destination, { delay: 80 });
    await humanDelay(page, 1000, 2000);
    await page.locator(`[role="option"]:has-text("${destination}"), li:has-text("${destination}")`).first().click().catch(() => page.keyboard.press("Enter"));
    await humanDelay(page);

    // 日期、人數、搜尋...
    await page.locator('button:has-text("搜尋"), button:has-text("Search"), button[type="submit"]').click();
    await page.waitForTimeout(5000);

    const flights = await parseResults(page);

    return {
      success: true,
      airline: AIRLINE,
      flights: flights.map((f) => ({ ...f, airline: "JX", airlineName: "星宇", type: "cash" })),
    };
  } catch (error) {
    logger.error("[星宇] 搜尋失敗", { error: error.message });
    return { success: false, error: `星宇搜尋失敗：${error.message}` };
  } finally {
    await closePage(page);
  }
}

async function searchMiles(params) {
  const account = config.mileageAccounts.JX;
  if (!account.id || !account.password) {
    return { success: false, error: "未設定星宇會員帳號" };
  }
  return { success: false, error: "星宇里程票爬蟲開發中" };
}

async function parseResults(page) {
  const flights = [];
  try {
    const cards = page.locator('.flight-card, [class*="flight-result"], [class*="FlightCard"]');
    const count = await cards.count();
    for (let i = 0; i < Math.min(count, 10); i++) {
      try {
        const card = cards.nth(i);
        flights.push({
          flightNumber: await card.locator('[class*="flightNo"], [class*="flight-number"]').textContent().catch(() => "JX???"),
          departTime: await card.locator('[class*="depart"], [class*="departure"]').textContent().catch(() => "--:--"),
          arriveTime: await card.locator('[class*="arrive"], [class*="arrival"]').textContent().catch(() => "--:--"),
          price: parseInt((await card.locator('[class*="price"], [class*="fare"]').textContent().catch(() => "0")).replace(/[^0-9]/g, "")) || 0,
          currency: "TWD",
          stops: 0,
          cabinClass: "ECONOMY",
        });
      } catch {}
    }
  } catch {}
  return flights;
}

function getBookingUrl(params) {
  return `${AIRLINE.bookingUrl}?from=${params.origin}&to=${params.destination}&date=${params.departDate}`;
}

module.exports = { AIRLINE, searchCash, searchMiles, getBookingUrl };
