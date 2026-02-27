// =============================================
// Playwright 瀏覽器管理器
//
// 管理瀏覽器的生命週期：
// - 啟動/關閉 Chromium
// - 反偵測設定
// - Railway / Docker 環境相容
// =============================================

const { chromium } = require("playwright");
const { config } = require("../config");
const logger = require("../utils/logger");

let browser = null;

/**
 * 取得或啟動瀏覽器
 */
async function getBrowser() {
  if (browser && browser.isConnected()) return browser;

  logger.info("[Browser] 啟動 Chromium...");

  try {
    browser = await chromium.launch({
      headless: config.browser.headless,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",            // Railway/Docker 共享記憶體不足
        "--disable-blink-features=AutomationControlled",
        "--disable-web-security",
        "--disable-gpu",                       // Docker 環境無 GPU
        "--lang=zh-TW",
        "--single-process",                    // 減少記憶體用量
      ],
    });

    logger.info("[Browser] Chromium 啟動成功");

    browser.on("disconnected", () => {
      logger.warn("[Browser] 瀏覽器斷線");
      browser = null;
    });

    return browser;
  } catch (error) {
    logger.error("[Browser] Chromium 啟動失敗！", {
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

/**
 * 建立新頁面（帶反偵測設定）
 */
async function createPage() {
  const b = await getBrowser();

  const context = await b.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 768 },
    locale: "zh-TW",
    timezoneId: "Asia/Taipei",
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();

  // 隱藏 Playwright 自動化特徵
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["zh-TW", "zh", "en-US", "en"] });
  });

  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(45000);

  return page;
}

/**
 * 安全地關閉頁面
 */
async function closePage(page) {
  try {
    if (page && !page.isClosed()) {
      await page.context().close();
    }
  } catch (e) {
    logger.debug("[Browser] 關閉頁面時發生錯誤（可忽略）", { error: e.message });
  }
}

/**
 * 擷取頁面截圖（除錯用）
 */
async function takeScreenshot(page, name) {
  try {
    const path = `screenshots/${name}-${Date.now()}.png`;
    await page.screenshot({ path, fullPage: false });
    logger.debug(`[Browser] 截圖已儲存: ${path}`);
    return path;
  } catch {
    return null;
  }
}

/**
 * 等待並重試（處理網站載入慢的情況）
 */
async function waitAndRetry(page, selector, options = {}) {
  const { timeout = 15000, retries = 2 } = options;

  for (let i = 0; i <= retries; i++) {
    try {
      await page.waitForSelector(selector, { timeout });
      return true;
    } catch {
      if (i < retries) {
        logger.debug(`[Browser] 等待 ${selector} 失敗，重試 ${i + 1}/${retries}`);
        await page.waitForTimeout(2000);
      }
    }
  }
  return false;
}

/**
 * 模擬人類行為的延遲
 */
async function humanDelay(page, min = 500, max = 1500) {
  const delay = Math.floor(Math.random() * (max - min) + min);
  await page.waitForTimeout(delay);
}

/**
 * 測試瀏覽器是否能正常啟動（診斷用）
 */
async function testBrowserLaunch() {
  let testBrowser = null;
  try {
    testBrowser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    const version = testBrowser.version();
    await testBrowser.close();
    return { success: true, version };
  } catch (error) {
    if (testBrowser) await testBrowser.close().catch(() => {});
    return { success: false, error: error.message };
  }
}

/**
 * 關閉所有瀏覽器資源
 */
async function shutdown() {
  logger.info("[Browser] 正在關閉瀏覽器...");
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
}

module.exports = {
  getBrowser,
  createPage,
  closePage,
  takeScreenshot,
  waitAndRetry,
  humanDelay,
  testBrowserLaunch,
  shutdown,
};
