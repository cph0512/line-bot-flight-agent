// =============================================
// 長榮航空 (EVA Air, BR) 爬蟲
//
// 目標：https://www.evaair.com/
// 結果頁：https://digital.evaair.com/booking/availability/0
//
// 長榮與華航都使用 Amadeus refx 平台，DOM 結構幾乎相同
// 差異：航班號用 .operating-airline-multiline 而非 .flight-number
//
// 最後更新：2026-02-27
// =============================================

const { createPage, closePage, humanDelay, takeScreenshot } = require("../browserManager");
const logger = require("../../utils/logger");
const { config } = require("../../config");

const AIRLINE = {
  code: "BR",
  name: "長榮",
  fullName: "長榮航空",
  baseUrl: "https://www.evaair.com",
  bookingUrl: "https://www.evaair.com/zh-tw/index.html",
};

async function searchCash(params) {
  const { origin, destination, departDate, returnDate, adults = 1 } = params;
  let page = null;

  try {
    page = await createPage();
    logger.info(`[長榮] 開始搜尋 ${origin}→${destination} ${departDate}`);

    // === 步驟 1：前往長榮首頁（訂票表單在首頁） ===
    await page.goto(AIRLINE.bookingUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(page, 2000, 3000);

    // 關閉可能的彈窗
    try {
      const closeBtn = page.locator('.modal-close, .popup-close, button[aria-label="Close"]').first();
      if (await closeBtn.isVisible({ timeout: 3000 })) await closeBtn.click();
    } catch {}

    // === 步驟 2：展開訂票表單 ===
    // 點擊「預訂行程」確保表單展開
    try {
      const bookingTab = page.locator("#bookingTab");
      if (await bookingTab.isVisible({ timeout: 3000 })) {
        await bookingTab.click();
        await humanDelay(page, 500, 1000);
      }
    } catch {}

    // 確保在「機票」頁籤
    try {
      const ticketTab = page.locator("#ticketTab");
      if (await ticketTab.isVisible({ timeout: 2000 })) {
        await ticketTab.click();
        await humanDelay(page, 300, 600);
      }
    } catch {}

    // === 步驟 3：填寫搜尋表單 ===

    // 選擇來回 / 單程
    if (!returnDate) {
      try {
        const oneWay = page.locator('input[type="radio"][value="O"], label:has-text("單程") input');
        if (await oneWay.isVisible({ timeout: 2000 })) await oneWay.click();
      } catch {}
    }
    await humanDelay(page, 300, 600);

    // 填入出發地（預設通常是 TPE）
    const originInput = page.locator("#booking_online_txt_From");
    await originInput.click();
    await humanDelay(page, 200, 500);
    await originInput.fill("");
    await originInput.type(origin, { delay: 80 });
    await humanDelay(page, 1000, 2000);
    // 選擇下拉選項
    const originOption = page.locator("ul.ui-autocomplete li").first();
    if (await originOption.isVisible({ timeout: 5000 })) {
      await originOption.click();
    } else {
      await page.keyboard.press("Enter");
    }
    await humanDelay(page);

    // 填入目的地
    const destInput = page.locator("#booking_online_txt_To");
    await destInput.click();
    await humanDelay(page, 200, 500);
    await destInput.fill("");
    await destInput.type(destination, { delay: 80 });
    await humanDelay(page, 1000, 2000);
    const destOption = page.locator("ul.ui-autocomplete li").first();
    if (await destOption.isVisible({ timeout: 5000 })) {
      await destOption.click();
    } else {
      await page.keyboard.press("Enter");
    }
    await humanDelay(page);

    // 填入日期（使用 flatpickr API）
    await page.evaluate(({ dep, ret }) => {
      const d1 = document.querySelector("#booking_online_txt_date1");
      if (d1 && d1._flatpickr) d1._flatpickr.setDate(dep);

      if (ret) {
        const d2 = document.querySelector("#booking_online_txt_date2");
        if (d2) {
          if (d2._flatpickr) {
            d2._flatpickr.setDate(ret);
          } else {
            d2.value = ret;
            d2.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
      }
    }, { dep: departDate, ret: returnDate });
    await humanDelay(page, 300, 600);

    // 填入人數
    if (adults > 1) {
      const adultInput = page.locator("#booking_online_wuc_Passengers_txt_Adult");
      if (await adultInput.isVisible({ timeout: 2000 })) {
        await adultInput.fill(String(adults));
      }
    }

    // === 步驟 4：送出搜尋 ===
    const searchBtn = page.locator("#btn_ok");
    await searchBtn.click();
    logger.info("[長榮] 已點擊搜尋");

    // === 步驟 5：等待結果頁（digital.evaair.com） ===
    await page.waitForURL(/digital\.evaair\.com/, { timeout: 30000 });
    await humanDelay(page, 2000, 3000);

    await page.waitForSelector(".basic-flight-card-layout-top-section-container", {
      timeout: 45000,
    });
    await humanDelay(page, 1000, 2000);

    logger.info("[長榮] 結果頁已載入");

    if (config.server.nodeEnv === "development") {
      await takeScreenshot(page, "br-results");
    }

    // === 步驟 6：解析結果（Amadeus refx 平台，與華航相同） ===
    const flights = await parseFlightResults(page);

    if (flights.length === 0) {
      return { success: true, flights: [], message: "長榮查無此航線或日期的航班" };
    }

    return {
      success: true,
      airline: AIRLINE,
      flights: flights.map((f) => ({ ...f, airline: "BR", airlineName: "長榮", type: "cash" })),
    };
  } catch (error) {
    logger.error("[長榮] 搜尋失敗", { error: error.message });
    if (page && config.server.nodeEnv === "development") {
      await takeScreenshot(page, "br-error");
    }
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
  return { success: false, error: "長榮里程票爬蟲開發中" };
}

/**
 * 解析航班結果（Amadeus refx 平台）
 * 長榮的 DOM 結構與華航幾乎相同，
 * 差異：航班號用 .operating-airline-multiline 而非 .flight-number
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
        const duration = card.querySelector(".duration-value")?.textContent.trim() || "";

        // 長榮的航班號在不同的 class
        const flightNumEls = card.querySelectorAll(".operating-airline-multiline, .flight-number");
        const flightNums = [...flightNumEls].map((el) => el.textContent.trim()).filter(Boolean);
        const flightNumber = flightNums.join(" / ");

        const stopContainer = card.querySelector(".bound-nb-stop-container");
        const hasStops = stopContainer?.classList.contains("has-stops");
        const stopCount = hasStops
          ? parseInt(stopContainer.querySelector(".nb-stop-shape")?.textContent.trim() || "1")
          : 0;

        const seatsLeft = card.querySelector(".ribbon")?.textContent.trim() || "";

        const fareButtons = card.querySelectorAll("button.flight-card-button-desktop-view");
        const fares = [];
        fareButtons.forEach((btn) => {
          const name = btn.querySelector(".refx-fare-family-flight-card-name")?.textContent.trim() || "";
          const priceEl = btn.querySelector("[data-amount]");
          const price = priceEl ? parseInt(priceEl.getAttribute("data-amount")) : 0;
          const mixCabin = btn.querySelector('[class*="mix"]')?.textContent.trim() || "";
          fares.push({ name, price, mixCabin });
        });

        results.push({ depTime, arrTime, duration, flightNumber, stopCount, seatsLeft, fares });
      }
      return results;
    });

    for (const data of flightData) {
      for (const fare of data.fares) {
        if (fare.price <= 0) continue;

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

    logger.info(`[長榮] 解析到 ${flights.length} 筆票價（${flightData.length} 個航班）`);
  } catch (error) {
    logger.error("[長榮] 解析結果失敗", { error: error.message });
  }

  return flights;
}

function getBookingUrl(params) {
  return `https://www.evaair.com/zh-tw/index.html`;
}

module.exports = { AIRLINE, searchCash, searchMiles, getBookingUrl };
