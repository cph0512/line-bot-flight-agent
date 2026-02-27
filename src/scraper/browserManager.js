// =============================================
// Playwright 瀏覽器管理器
//
// 管理瀏覽器的生命週期：
// - 啟動/關閉 Chromium
// - 頁面池（重複使用頁面，避免反覆開關）
// - 反偵測設定（讓網站以為是真人瀏覽）
// =============================================

const { chromium } = require("playwright");
const { config } = require("../config");
const logger = require("../utils/logger");

let browser = null;
const pagePool = []; // 可重複使用的頁面

/**
 * 取得或啟動瀏覽器
 */
async function getBrowser() {
  if (browser && browser.isConnected()) return browser;

  logger.info("🚀 啟動 Chromium 瀏覽器...");

  browser = await chromium.launch({
    headless: config.browser.headless,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled", // 反偵測
      "--disable-web-security",
      "--lang=zh-TW",
    ],
  });

  // 瀏覽器意外關閉時清理
  browser.on("disconnected", () => {
    logger.warn("瀏覽器斷線");
    browser = null;
    pagePool.length = 0;
  });

  return browser;
}

/**
 * 建立新頁面（帶反偵測設定）
 */
async function createPage() {
  const b = await getBrowser();

  const context = await b.newContext({
    // 模擬真實瀏覽器
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 768 },
    locale: "zh-TW",
    timezoneId: "Asia/Taipei",
    // 接受 cookie
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();

  // 隱藏 Playwright 自動化特徵
  await page.addInitScript(() => {
    // 移除 webdriver 標記
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    // 偽造 plugins
    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5],
    });
    // 偽造語言
    Object.defineProperty(navigator, "languages", {
      get: () => ["zh-TW", "zh", "en-US", "en"],
    });
  });

  // 設定預設超時
  page.setDefaultTimeout(30000); // 30 秒
  page.setDefaultNavigationTimeout(45000); // 45 秒

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
    logger.debug("關閉頁面時發生錯誤（可忽略）", { error: e.message });
  }
}

/**
 * 擷取頁面截圖（除錯用）
 */
async function takeScreenshot(page, name) {
  try {
    const path = `screenshots/${name}-${Date.now()}.png`;
    await page.screenshot({ path, fullPage: false });
    logger.debug(`截圖已儲存: ${path}`);
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
        logger.debug(`等待 ${selector} 失敗，重試 ${i + 1}/${retries}`);
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
 * 關閉所有瀏覽器資源
 */
async function shutdown() {
  logger.info("正在關閉瀏覽器...");
  pagePool.length = 0;
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
  shutdown,
};
