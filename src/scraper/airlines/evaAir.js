// =============================================
// 長榮航空 (EVA Air, BR) 爬蟲
//
// 目標：https://www.evaair.com/
// 結構與華航爬蟲相同，selector 不同
//
// ⚠️ 需要根據長榮官網實際 DOM 結構調整 selector
// =============================================

const { createPage, closePage, humanDelay, takeScreenshot } = require("../browserManager");
const logger = require("../../utils/logger");
const { config } = require("../../config");

const AIRLINE = {
  code: "BR",
  name: "長榮",
  fullName: "長榮航空",
  baseUrl: "https://www.evaair.com",
  bookingUrl: "https://www.evaair.com/zh-tw/booking/fare-search/",
};

async function searchCash(params) {
  const { origin, destination, departDate, returnDate, adults = 1 } = params;
  let page = null;

  try {
    page = await createPage();
    logger.info(`[長榮] 開始搜尋 ${origin}→${destination} ${departDate}`);

    await page.goto(AIRLINE.bookingUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(page);

    // === 長榮官網的表單填寫邏輯 ===
    // 註：以下 selector 為示意，需根據長榮官網實際結構調整

    // 關閉彈窗
    try {
      const closeBtn = page.locator('.modal-close, .popup-close, button[aria-label="Close"]').first();
      if (await closeBtn.isVisible({ timeout: 3000 })) await closeBtn.click();
    } catch {}

    // 出發地
    const originInput = page.locator('#origin, input[name="origin"], .origin-input input');
    await originInput.click();
    await originInput.fill("");
    await originInput.type(origin, { delay: 80 });
    await humanDelay(page, 1000, 2000);
    await page.locator(`li:has-text("${origin}"), .suggestion:has-text("${origin}")`).first().click().catch(() => {
      page.keyboard.press("Enter");
    });
    await humanDelay(page);

    // 目的地
    const destInput = page.locator('#destination, input[name="destination"], .destination-input input');
    await destInput.click();
    await destInput.fill("");
    await destInput.type(destination, { delay: 80 });
    await humanDelay(page, 1000, 2000);
    await page.locator(`li:has-text("${destination}"), .suggestion:has-text("${destination}")`).first().click().catch(() => {
      page.keyboard.press("Enter");
    });
    await humanDelay(page);

    // 日期、人數、搜尋（類似華航邏輯，省略重複）
    // ...

    // 搜尋
    await page.locator('button:has-text("搜尋"), button.search-btn, button[type="submit"]').click();
    await page.waitForTimeout(5000);

    // 解析結果
    const flights = await parseResults(page);

    return {
      success: true,
      airline: AIRLINE,
      flights: flights.map((f) => ({ ...f, airline: "BR", airlineName: "長榮", type: "cash" })),
    };
  } catch (error) {
    logger.error("[長榮] 搜尋失敗", { error: error.message });
    return { success: false, error: `長榮搜尋失敗：${error.message}` };
  } finally {
    await closePage(page);
  }
}

async function searchMiles(params) {
  const account = config.mileageAccounts.BR;
  if (!account.id || !account.password) {
    return { success: false, error: "未設定長榮會員帳號，無法查里程票" };
  }

  // 長榮里程票查詢邏輯（需登入 Infinity MileageLands）
  // 結構類似華航的 searchMiles
  return { success: false, error: "長榮里程票爬蟲開發中" };
}

async function parseResults(page) {
  const flights = [];
  try {
    const cards = page.locator('.flight-info, .flight-card, [class*="flight"]');
    const count = await cards.count();

    for (let i = 0; i < Math.min(count, 10); i++) {
      try {
        const card = cards.nth(i);
        flights.push({
          flightNumber: await card.locator('.flight-no, .flight-number').textContent().catch(() => "BR???"),
          departTime: await card.locator('.depart, .departure-time').textContent().catch(() => "--:--"),
          arriveTime: await card.locator('.arrive, .arrival-time').textContent().catch(() => "--:--"),
          price: parseInt((await card.locator('.price, .fare').textContent().catch(() => "0")).replace(/[^0-9]/g, "")) || 0,
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
  return `${AIRLINE.bookingUrl}?origin=${params.origin}&destination=${params.destination}&departureDate=${params.departDate}`;
}

module.exports = { AIRLINE, searchCash, searchMiles, getBookingUrl };
