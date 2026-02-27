// =============================================
// 星宇航空 (STARLUX, JX) 爬蟲
//
// 目標：https://www.starlux-airlines.com/
// 結果頁：https://www.starlux-airlines.com/zh-TW/booking/search-result
//
// 星宇官網是 Vue SPA，訂票表單使用自訂元件：
// - 出發地 / 目的地：按鈕觸發 modal，內有 combobox 搜尋
// - 日期：文字輸入框，點擊後開啟日曆彈窗
// - 艙等 / 旅客：文字輸入框
// - 結果頁使用 data-qa 屬性標記各元素
//
// 最後更新：2026-02-27
// =============================================

const { createPage, closePage, humanDelay, takeScreenshot } = require("../browserManager");
const logger = require("../../utils/logger");
const { config } = require("../../config");

const AIRLINE = {
  code: "JX",
  name: "星宇",
  fullName: "星宇航空",
  baseUrl: "https://www.starlux-airlines.com",
  bookingUrl: "https://www.starlux-airlines.com/zh-TW/booking",
};

/**
 * 搜尋星宇現金票
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
    logger.info(`[星宇] 開始搜尋現金票 ${origin}-${destination} ${departDate}`);

    // === 步驟 1：前往星宇訂票頁面 ===
    await page.goto(AIRLINE.bookingUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(page, 2000, 3000);

    // 關閉可能的彈窗（cookie 提示、廣告等）
    await dismissPopup(page);

    // === 步驟 2：選擇單程 / 來回 ===
    if (!returnDate) {
      try {
        const tripSelect = page.locator("select").filter({ hasText: /單程|one-way|round-trip/i }).first();
        if (await tripSelect.isVisible({ timeout: 3000 })) {
          await tripSelect.selectOption("one-way");
          await humanDelay(page, 300, 600);
          logger.info("[星宇] 已選擇單程");
        }
      } catch {
        logger.debug("[星宇] 單程選擇失敗，嘗試備用方式");
        // 備用：嘗試直接用 page.evaluate 設定 select
        try {
          await page.evaluate(() => {
            const selects = document.querySelectorAll("select");
            for (const sel of selects) {
              const options = [...sel.options];
              const oneWay = options.find((o) => o.value === "one-way");
              if (oneWay) {
                sel.value = "one-way";
                sel.dispatchEvent(new Event("change", { bubbles: true }));
                break;
              }
            }
          });
          await humanDelay(page, 300, 600);
        } catch {}
      }
    }

    // === 步驟 3：填入出發地 ===
    await selectAirport(page, "出發地", origin);
    await humanDelay(page, 500, 1000);

    // === 步驟 4：填入目的地 ===
    await selectAirport(page, "目的地", destination);
    await humanDelay(page, 500, 1000);

    // === 步驟 5：填入日期 ===
    await fillDates(page, departDate, returnDate);
    await humanDelay(page, 500, 1000);

    // === 步驟 6：點擊搜尋 ===
    const searchBtn = page.locator('button:has-text("搜尋")').filter({ has: page.locator("*") }).first();
    // 備用 selector：class 包含 w-full lg:w-1/5 ml-auto 的按鈕
    const searchBtnAlt = page.locator('button.w-full:has-text("搜尋")');
    try {
      if (await searchBtn.isVisible({ timeout: 3000 })) {
        await searchBtn.click();
      } else if (await searchBtnAlt.isVisible({ timeout: 2000 })) {
        await searchBtnAlt.click();
      } else {
        // 最後備用：任何包含「搜尋」文字的按鈕
        await page.locator('button:has-text("搜尋")').first().click();
      }
    } catch {
      await page.locator('button:has-text("搜尋")').first().click();
    }
    logger.info("[星宇] 已點擊搜尋，等待結果頁...");

    // === 步驟 7：等待結果頁載入 ===
    await page.waitForURL(/search-result/, { timeout: 30000 });
    await humanDelay(page, 2000, 3000);

    // 等待航班艙等按鈕出現（表示結果已載入）
    try {
      await page.waitForSelector('[data-qa="qa-btn-cabin"]', { timeout: 45000 });
    } catch {
      // 可能沒有航班
      logger.warn("[星宇] 未偵測到艙等按鈕，可能無航班");
      if (config.server.nodeEnv === "development") {
        await takeScreenshot(page, "jx-no-results");
      }
      return { success: true, flights: [], message: "星宇查無此航線或日期的航班" };
    }
    await humanDelay(page, 1000, 2000);

    logger.info("[星宇] 結果頁已載入");

    // 截圖（除錯用）
    if (config.server.nodeEnv === "development") {
      await takeScreenshot(page, "jx-results");
    }

    // === 步驟 8：解析結果 ===
    const flights = await parseFlightResults(page);

    if (flights.length === 0) {
      return { success: true, flights: [], message: "星宇查無此航線或日期的航班" };
    }

    return {
      success: true,
      airline: AIRLINE,
      flights: flights.map((f) => ({ ...f, airline: "JX", airlineName: "星宇", type: "cash" })),
    };
  } catch (error) {
    logger.error("[星宇] 現金票搜尋失敗", { error: error.message });
    if (page && config.server.nodeEnv === "development") {
      await takeScreenshot(page, "jx-error");
    }
    return { success: false, error: `星宇搜尋失敗：${error.message}` };
  } finally {
    await closePage(page);
  }
}

/**
 * 搜尋星宇里程票（開發中）
 */
async function searchMiles(params) {
  return { success: false, error: "星宇里程票爬蟲開發中" };
}

// === 內部輔助函式 ===

/**
 * 關閉可能的彈窗（cookie、廣告、公告等）
 */
async function dismissPopup(page) {
  try {
    // 嘗試找到關閉按鈕（X 按鈕）
    const closeBtns = [
      page.locator('button[aria-label="Close"], button[aria-label="關閉"]').first(),
      page.locator('.modal-close, .popup-close, [class*="close-btn"]').first(),
      page.locator('button:has(svg[class*="close"]), button:has([class*="icon-close"])').first(),
    ];
    for (const btn of closeBtns) {
      try {
        if (await btn.isVisible({ timeout: 2000 })) {
          await btn.click();
          await humanDelay(page, 300, 600);
          logger.debug("[星宇] 已關閉彈窗");
          break;
        }
      } catch {}
    }
  } catch {}

  // 也嘗試關閉 cookie banner
  try {
    const cookieBtn = page.locator('button:has-text("接受"), button:has-text("我同意"), button:has-text("Accept")').first();
    if (await cookieBtn.isVisible({ timeout: 2000 })) {
      await cookieBtn.click();
      await humanDelay(page, 300, 600);
    }
  } catch {}
}

/**
 * 選擇機場（出發地或目的地）
 *
 * 星宇的出發地/目的地不是文字輸入框，而是按鈕。
 * 點擊按鈕後會打開 modal，內有 combobox 可搜尋機場。
 *
 * @param {import('playwright').Page} page
 * @param {string} label - "出發地" 或 "目的地"
 * @param {string} iataCode - 機場 IATA 代碼，如 "TPE"
 */
async function selectAirport(page, label, iataCode) {
  logger.debug(`[星宇] 選擇${label}: ${iataCode}`);

  // 點擊觸發按鈕（按鈕文字包含「出發地」或「目的地」）
  const triggerBtn = page.locator(`button:has-text("${label}")`).first();
  try {
    await triggerBtn.waitFor({ state: "visible", timeout: 5000 });
    await triggerBtn.click();
  } catch {
    // 備用方式：透過文字內容尋找按鈕
    logger.debug(`[星宇] 主按鈕未找到，嘗試備用 selector`);
    await page.locator(`button >> text=${label}`).first().click();
  }
  await humanDelay(page, 500, 1000);

  // 等待 modal 中的 combobox 出現
  const combobox = page.locator('[role="combobox"]').first();
  await combobox.waitFor({ state: "visible", timeout: 5000 });

  // 清空並輸入 IATA 代碼
  await combobox.fill("");
  await combobox.type(iataCode, { delay: 100 });
  await humanDelay(page, 1000, 2000);

  // 等待 listbox 選項出現並點擊匹配的選項
  const option = page.locator('[role="option"]').filter({ hasText: iataCode }).first();
  try {
    await option.waitFor({ state: "visible", timeout: 5000 });
    await option.click();
  } catch {
    // 備用：點擊第一個選項
    logger.debug(`[星宇] 未找到匹配 ${iataCode} 的選項，嘗試第一個選項`);
    const firstOption = page.locator('[role="option"]').first();
    if (await firstOption.isVisible({ timeout: 3000 })) {
      await firstOption.click();
    } else {
      // 最後備用：按 Enter
      await page.keyboard.press("Enter");
    }
  }

  await humanDelay(page, 300, 600);
  logger.info(`[星宇] ${label}已選擇: ${iataCode}`);
}

/**
 * 填入旅行日期
 *
 * 星宇的日期是文字輸入框，格式為：
 * - 來回：YYYY/MM/DD - YYYY/MM/DD
 * - 單程：YYYY/MM/DD
 *
 * 由於日曆元件點選不可靠，使用 page.evaluate 直接設值。
 *
 * @param {import('playwright').Page} page
 * @param {string} departDate - "2025-03-15"
 * @param {string} returnDate - "2025-03-20" (optional)
 */
async function fillDates(page, departDate, returnDate) {
  const formatDate = (dateStr) => {
    const [year, month, day] = dateStr.split("-");
    return `${year}/${month}/${day}`;
  };

  const depFormatted = formatDate(departDate);
  let dateValue;
  if (returnDate) {
    const retFormatted = formatDate(returnDate);
    dateValue = `${depFormatted} - ${retFormatted}`;
  } else {
    dateValue = depFormatted;
  }

  // 先點擊日期輸入框觸發日曆
  try {
    // 嘗試用 label 文字尋找日期輸入框
    const dateInput = page.locator('input').filter({ hasText: /旅行日期/ }).first();
    const dateInputAlt = page.locator('input[placeholder*="日期"], input[aria-label*="日期"]').first();

    // 嘗試點擊日期欄位
    let clicked = false;
    for (const input of [dateInput, dateInputAlt]) {
      try {
        if (await input.isVisible({ timeout: 2000 })) {
          await input.click();
          clicked = true;
          break;
        }
      } catch {}
    }

    if (!clicked) {
      // 備用：找包含日期格式的 input
      const inputs = page.locator("input");
      const count = await inputs.count();
      for (let i = 0; i < count; i++) {
        const val = await inputs.nth(i).inputValue().catch(() => "");
        if (val.includes("/") || val.includes("日期")) {
          await inputs.nth(i).click();
          clicked = true;
          break;
        }
      }
    }
    await humanDelay(page, 300, 600);
  } catch {
    logger.debug("[星宇] 點擊日期輸入框失敗");
  }

  // 使用 page.evaluate 直接設定日期值（最可靠的方式）
  await page.evaluate((dateVal) => {
    // 找到日期相關的 input（通常會有「旅行日期」label 或值中含有 /）
    const inputs = document.querySelectorAll("input");
    for (const input of inputs) {
      const label = input.getAttribute("aria-label") || "";
      const placeholder = input.getAttribute("placeholder") || "";
      const currentVal = input.value || "";

      if (
        label.includes("旅行日期") ||
        label.includes("日期") ||
        placeholder.includes("日期") ||
        /\d{4}\/\d{2}\/\d{2}/.test(currentVal)
      ) {
        // 使用原生 setter 觸發 Vue 的響應式更新
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value"
        ).set;
        nativeInputValueSetter.call(input, dateVal);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        break;
      }
    }
  }, dateValue);

  await humanDelay(page, 300, 600);

  // 關閉日曆彈窗（點擊空白處或按 Escape）
  try {
    await page.keyboard.press("Escape");
    await humanDelay(page, 200, 400);
  } catch {}

  logger.info(`[星宇] 日期已設定: ${dateValue}`);
}

/**
 * 解析航班搜尋結果
 *
 * 結果頁 DOM 結構（data-qa 屬性）：
 * - [data-qa="qa-title-flight"]    - 航線標題（如「去程： 臺北 - 東京」）
 * - 航班卡片包含：航班號、時間、航站、飛行時間
 * - [data-qa="qa-list-cabins"]     - 艙等列表容器
 * - [data-qa="qa-btn-cabin"]       - 艙等選擇按鈕
 * - [data-qa="qa-lbl-cabin"]       - 艙等名稱（經濟艙、豪華經濟艙、商務艙）
 * - [data-qa="qa-lbl-price"]       - 價格（內含 <strong> 顯示數字）
 *
 * 航班號以 JX 開頭，如 JX800，在葉節點文字中匹配。
 */
async function parseFlightResults(page) {
  const flights = [];

  try {
    const flightData = await page.evaluate(() => {
      const results = [];

      // 找出所有航班號元素（葉節點，文字匹配 JX + 3~4 位數字）
      const allElements = document.querySelectorAll("*");
      const flightNumElements = [];

      for (const el of allElements) {
        // 必須是葉節點（沒有子元素）
        if (el.children.length > 0) continue;
        const text = (el.textContent || "").trim();
        if (/^JX\d{3,4}$/.test(text)) {
          flightNumElements.push(el);
        }
      }

      for (const flightEl of flightNumElements) {
        const flightNumber = flightEl.textContent.trim();

        // 往上找到包含 [data-qa="qa-list-cabins"] 的容器（航班卡片）
        let card = flightEl.parentElement;
        let maxDepth = 20;
        while (card && maxDepth > 0) {
          if (card.querySelector('[data-qa="qa-list-cabins"]')) {
            break;
          }
          card = card.parentElement;
          maxDepth--;
        }

        if (!card || !card.querySelector('[data-qa="qa-list-cabins"]')) {
          continue;
        }

        // 避免同一卡片重複解析（多個航班號的情況）
        if (card.dataset._parsed) continue;
        card.dataset._parsed = "1";

        // 提取時間資訊
        // 時間格式：HH:MM，在卡片文字中尋找
        const cardText = card.textContent || "";
        const timeMatches = cardText.match(/\b(\d{2}:\d{2})\b/g) || [];
        const departTime = timeMatches[0] || "--:--";
        const arriveTime = timeMatches[1] || "--:--";

        // 提取機場代碼（3 個大寫字母）
        const airportMatches = cardText.match(/\b([A-Z]{3})\b/g) || [];
        // 過濾掉 JX 開頭的航班號中可能匹配到的
        const airports = airportMatches.filter(
          (code) => !/^JX/.test(code) && code !== "JX" && code.length === 3
        );
        const originCode = airports[0] || "";
        const destCode = airports[1] || "";

        // 提取飛行時間（如「3 小時 10 分鐘」）
        const durationMatch = cardText.match(/(\d+)\s*小時\s*(\d+)\s*分/);
        const duration = durationMatch
          ? `${durationMatch[1]}小時${durationMatch[2]}分鐘`
          : "";

        // 提取各艙等票價
        const cabinBtns = card.querySelectorAll('[data-qa="qa-btn-cabin"]');
        const cabins = [];

        for (const btn of cabinBtns) {
          const cabinLabel = btn.querySelector('[data-qa="qa-lbl-cabin"]');
          const priceLabel = btn.querySelector('[data-qa="qa-lbl-price"]');

          const cabinName = cabinLabel ? cabinLabel.textContent.trim() : "";
          // 價格在 <strong> 元素中，格式如 "10,511"
          const priceStrong = priceLabel ? priceLabel.querySelector("strong") : null;
          const priceText = priceStrong
            ? priceStrong.textContent.trim()
            : priceLabel
              ? priceLabel.textContent.trim()
              : "0";
          const price = parseInt(priceText.replace(/[^0-9]/g, "")) || 0;

          if (cabinName) {
            cabins.push({ cabinName, price });
          }
        }

        results.push({
          flightNumber,
          departTime,
          arriveTime,
          origin: originCode,
          destination: destCode,
          duration,
          cabins,
        });
      }

      // 清理暫存標記
      document.querySelectorAll("[data-_parsed]").forEach((el) => {
        delete el.dataset._parsed;
      });

      return results;
    });

    // 將每個航班的各艙等拆成獨立的 flight 記錄
    for (const data of flightData) {
      for (const cabin of data.cabins) {
        if (cabin.price <= 0) continue;

        // 艙等名稱對照
        let cabinClass = "ECONOMY";
        if (cabin.cabinName.includes("商務")) {
          cabinClass = "BUSINESS";
        } else if (cabin.cabinName.includes("豪華經濟")) {
          cabinClass = "PREMIUM_ECONOMY";
        }

        flights.push({
          flightNumber: data.flightNumber,
          departTime: data.departTime,
          arriveTime: data.arriveTime,
          origin: data.origin,
          destination: data.destination,
          duration: data.duration,
          price: cabin.price,
          currency: "TWD",
          stops: 0,
          cabinClass,
          cabinName: cabin.cabinName,
        });
      }
    }

    logger.info(`[星宇] 解析到 ${flights.length} 筆票價（${flightData.length} 個航班）`);
  } catch (error) {
    logger.error("[星宇] 解析結果失敗", { error: error.message });
  }

  return flights;
}

/**
 * 產生星宇官網的訂票連結
 */
function getBookingUrl(params) {
  return "https://www.starlux-airlines.com/zh-TW/booking";
}

module.exports = { AIRLINE, searchCash, searchMiles, getBookingUrl };
