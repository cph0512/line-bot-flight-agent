// =============================================
// 新聞服務 — NewsAPI
//
// 免費註冊：https://newsapi.org/
// 免費版：100 requests/day
// 內建 10 分鐘快取，避免浪費 quota
// =============================================

const logger = require("../utils/logger");
const { config } = require("../config");

const VALID_CATEGORIES = ["general", "business", "technology", "sports", "entertainment", "health", "science"];

const CATEGORY_NAMES = {
  general: "綜合", business: "財經", technology: "科技",
  sports: "體育", entertainment: "娛樂", health: "健康", science: "科學",
};

// 簡易記憶體快取（10 分鐘 TTL）
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

function isAvailable() {
  return !!config.news?.apiKey;
}

/**
 * 查詢新聞
 * @param {string} category - 分類
 * @param {number} count - 筆數（1-10）
 */
async function getNews(category, count = 5) {
  if (!isAvailable()) {
    return { text: "新聞查詢功能未啟用（未設定 NEWS_API_KEY）。" };
  }

  const cat = VALID_CATEGORIES.includes(category) ? category : "general";
  const num = Math.min(Math.max(count, 1), 10);
  const catName = CATEGORY_NAMES[cat];

  logger.info(`[News] 查詢 ${catName} 新聞 ${num} 筆`);

  // 檢查快取
  const cacheKey = `${cat}:${num}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    logger.info(`[News] 使用快取（${Math.round((Date.now() - cached.time) / 1000)}秒前）`);
    return cached.result;
  }

  try {
    const url = `https://newsapi.org/v2/top-headlines?country=tw&category=${cat}&pageSize=${num}&apiKey=${config.news.apiKey}`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`NewsAPI 回傳 ${res.status}: ${body.slice(0, 100)}`);
    }

    const data = await res.json();
    const articles = data.articles || [];

    if (articles.length === 0) {
      return { text: `查無${catName}新聞。` };
    }

    let text = `=== 台灣${catName}新聞 (前${articles.length}則) ===\n`;

    articles.forEach((article, i) => {
      const title = article.title || "（無標題）";
      const source = article.source?.name || "未知來源";
      const date = article.publishedAt ? article.publishedAt.slice(0, 10) : "";
      const desc = article.description
        ? article.description.slice(0, 60) + (article.description.length > 60 ? "..." : "")
        : "";

      text += `\n${i + 1}. ${title}\n`;
      text += `   來源: ${source}`;
      if (date) text += ` | ${date}`;
      text += "\n";
      if (desc) text += `   ${desc}\n`;
    });

    const result = { text };

    // 存入快取
    cache.set(cacheKey, { time: Date.now(), result });

    return result;
  } catch (error) {
    logger.error(`[News] 查詢失敗: ${error.message}`);
    return { text: `新聞查詢失敗：${error.message}` };
  }
}

module.exports = { isAvailable, getNews, CATEGORY_NAMES };
