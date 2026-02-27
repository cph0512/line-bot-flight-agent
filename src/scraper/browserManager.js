// =============================================
// Playwright 瀏覽器管理器（Stealth 版）
//
// 使用 playwright-extra + stealth plugin 繞過反爬蟲：
// - 隱藏 navigator.webdriver
// - 修改 chrome.runtime
// - 偽造 plugins / languages / WebGL
// - 模擬真人滑鼠和鍵盤行為
// =============================================

const { chromium } = require("playwright-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { config } = require("../config");
const logger = require("../utils/logger");

// 啟用 stealth 插件
chromium.use(StealthPlugin());

let browser = null;

/**
 * 取得或啟動瀏覽器（使用 stealth 模式）
 */
async function getBrowser() {
  if (browser && browser.isConnected()) return browser;

  logger.info("[Browser] 啟動 Stealth Chromium...");

  try {
    browser = await chromium.launch({
      headless: config.browser.headless,
      // 不要用 --single-process（會導致一個頁面失敗整個瀏覽器崩潰）
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--disable-gpu",
        "--lang=zh-TW",
        "--window-size=1366,768",
      ],
    });

    logger.info("[Browser] Stealth Chromium 啟動成功");

    browser.on("disconnected", () => {
      logger.warn("[Browser] 瀏覽器斷線");
      browser = null;
    });

    return browser;
  } catch (error) {
    logger.error("[Browser] Chromium 啟動失敗", { error: error.message });
    throw error;
  }
}

/**
 * 建立新頁面（真實瀏覽器指紋 + 反偵測）
 */
async function createPage() {
  const b = await getBrowser();

  // 使用真實的 Chrome User-Agent（最新穩定版）
  const context = await b.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 768 },
    locale: "zh-TW",
    timezoneId: "Asia/Taipei",
    ignoreHTTPSErrors: true,
    // 模擬真實螢幕
    screen: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    hasTouch: false,
    isMobile: false,
    // 接受所有 cookie
    javaScriptEnabled: true,
  });

  const page = await context.newPage();

  // 額外的反偵測 — stealth 插件已處理大部分，這裡補充
  await page.addInitScript(() => {
    // 偽造 navigator.plugins（真實 Chrome 有 5 個 plugins）
    Object.defineProperty(navigator, "plugins", {
      get: () => {
        return [
          { name: "Chrome PDF Plugin", filename: "internal-pdf-viewer" },
          { name: "Chrome PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai" },
          { name: "Native Client", filename: "internal-nacl-plugin" },
          { name: "Chromium PDF Plugin", filename: "internal-pdf-viewer" },
          { name: "Chromium PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai" },
        ];
      },
    });

    // 偽造 navigator.languages
    Object.defineProperty(navigator, "languages", {
      get: () => ["zh-TW", "zh", "en-US", "en"],
    });

    // 偽造 WebGL vendor/renderer（真實 Mac Chrome 的值）
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (param) {
      if (param === 37445) return "Intel Inc.";
      if (param === 37446) return "Intel Iris OpenGL Engine";
      return getParameter.call(this, param);
    };

    // 移除 Playwright 留下的 __playwright 痕跡
    delete window.__playwright;
    delete window.__pw_manual;
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
 * 擷取截圖
 */
async function takeScreenshot(page, name) {
  try {
    const path = `screenshots/${name}-${Date.now()}.png`;
    await page.screenshot({ path, fullPage: false });
    logger.debug(`[Browser] 截圖: ${path}`);
    return path;
  } catch {
    return null;
  }
}

/**
 * 等待並重試
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
 * 模擬真人延遲（隨機）
 */
async function humanDelay(page, min = 500, max = 1500) {
  const delay = Math.floor(Math.random() * (max - min) + min);
  await page.waitForTimeout(delay);
}

/**
 * 模擬真人滑鼠移動（隨機曲線）
 */
async function humanMouseMove(page) {
  const x = 200 + Math.floor(Math.random() * 800);
  const y = 200 + Math.floor(Math.random() * 400);
  await page.mouse.move(x, y, { steps: 10 + Math.floor(Math.random() * 20) });
}

/**
 * 模擬真人打字（帶隨機延遲）
 */
async function humanType(page, selector, text) {
  const el = page.locator(selector);
  await el.click();
  await humanDelay(page, 100, 300);
  // 一個字一個字打，模擬真人
  for (const char of text) {
    await page.keyboard.type(char, { delay: 50 + Math.floor(Math.random() * 100) });
  }
}

/**
 * 測試瀏覽器是否能啟動（診斷用）
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
    return { success: true, version: `Stealth Chromium ${version}` };
  } catch (error) {
    if (testBrowser) await testBrowser.close().catch(() => {});
    return { success: false, error: error.message };
  }
}

/**
 * 關閉瀏覽器
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
  humanMouseMove,
  humanType,
  testBrowserLaunch,
  shutdown,
};
