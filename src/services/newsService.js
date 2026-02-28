// =============================================
// 新聞服務 — Google News RSS（免費、無限制）
//
// 主要來源：Google News RSS（不需 API key）
// 備援來源：NewsAPI（如有設定 KEY，本地開發可用）
// 內建 10 分鐘快取
// =============================================

const logger = require("../utils/logger");
const { config } = require("../config");

const VALID_CATEGORIES = ["general", "business", "technology", "sports", "entertainment", "health", "science"];

const CATEGORY_NAMES = {
  general: "綜合", business: "財經", technology: "科技",
  sports: "體育", entertainment: "娛樂", health: "健康", science: "科學",
};

// Google News RSS topic IDs（台灣版）
const GOOGLE_NEWS_TOPICS = {
  general: "CAAqJggKIiBDQkFTRWdvSUwyMHZNRFZxYUdjU0FucG9HZ0pVVnlnQVAB",       // 焦點新聞
  business: "CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FucG9HZ0pVVnlnQVAB",      // 商業
  technology: "CAAqJggKIiBDQkFTRWdvSUwyMHZNRGRqTVhZU0FucG9HZ0pVVnlnQVAB",    // 科技
  sports: "CAAqJggKIiBDQkFTRWdvSUwyMHZNRFp1ZEdvU0FucG9HZ0pVVnlnQVAB",        // 體育
  entertainment: "CAAqJggKIiBDQkFTRWdvSUwyMHZNREpxYW5RU0FucG9HZ0pVVnlnQVAB",  // 娛樂
  health: "CAAqIQgKIhtDQkFTRGdvSUwyMHZNR3QwTlRFU0FucG9LQUFQAQ",              // 健康
  science: "CAAqJggKIiBDQkFTRWdvSUwyMHZNRFp0Y1RjU0FucG9HZ0pVVnlnQVAB",       // 科學
};

// 簡易記憶體快取（10 分鐘 TTL）
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

/**
 * 新聞功能永遠可用（Google News RSS 不需 API key）
 */
function isAvailable() {
  return true;
}

/**
 * 從 Google News RSS XML 中提取文章
 * 使用正則解析，避免引入 XML parser 依賴
 */
function parseRssXml(xml, count) {
  const articles = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null && articles.length < count) {
    const item = match[1];

    const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]>|<title>(.*?)<\/title>/);
    const title = titleMatch ? (titleMatch[1] || titleMatch[2] || "").trim() : "";

    const sourceMatch = item.match(/<source[^>]*>(.*?)<\/source>/) || item.match(/<source[^>]*><!\[CDATA\[(.*?)\]\]><\/source>/);
    const source = sourceMatch ? (sourceMatch[1] || "").trim() : "";

    const pubDateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);
    const pubDate = pubDateMatch ? pubDateMatch[1].trim() : "";

    // 跳過空標題或 "[Removed]" 類的無效文章
    if (!title || title === "[Removed]") continue;

    // 清理標題（Google News 格式：「標題 - 來源」）
    const cleanTitle = title.replace(/\s*-\s*[^-]+$/, "").trim() || title;

    articles.push({
      title: cleanTitle,
      source: source || extractSourceFromTitle(title),
      date: pubDate ? formatDate(pubDate) : "",
    });
  }

  return articles;
}

/**
 * 從 Google News 標題格式提取來源（「標題 - 來源」）
 */
function extractSourceFromTitle(title) {
  const parts = title.split(" - ");
  return parts.length > 1 ? parts[parts.length - 1].trim() : "Google News";
}

/**
 * 格式化日期為 YYYY-MM-DD
 */
function formatDate(dateStr) {
  try {
    return new Date(dateStr).toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

/**
 * 查詢新聞（Google News RSS）
 * @param {string} category - 分類
 * @param {number} count - 筆數（1-10）
 */
async function getNews(category, count = 5) {
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

  // 優先 Google News RSS
  try {
    const result = await fetchGoogleNews(cat, num, catName);
    if (result) {
      cache.set(cacheKey, { time: Date.now(), result });
      return result;
    }
  } catch (error) {
    logger.error(`[News] Google News RSS 失敗: ${error.message}`);
  }

  // 備援：NewsAPI（如有設定）
  if (config.news?.apiKey) {
    try {
      const result = await fetchNewsAPI(cat, num, catName);
      if (result) {
        cache.set(cacheKey, { time: Date.now(), result });
        return result;
      }
    } catch (error) {
      logger.error(`[News] NewsAPI 備援失敗: ${error.message}`);
    }
  }

  return { text: `新聞查詢失敗，請稍後再試。` };
}

/**
 * Google News RSS 來源
 */
async function fetchGoogleNews(cat, num, catName) {
  const topicId = GOOGLE_NEWS_TOPICS[cat];
  // Google News Taiwan RSS
  const url = topicId
    ? `https://news.google.com/rss/topics/${topicId}?hl=zh-TW&gl=TW&ceid=TW:zh-Hant`
    : `https://news.google.com/rss?hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;

  logger.info(`[News] 呼叫 Google News RSS: ${cat}`);

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; LineBot/1.0)",
      "Accept": "application/rss+xml, application/xml, text/xml",
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    throw new Error(`Google News RSS 回傳 ${res.status}`);
  }

  const xml = await res.text();
  const articles = parseRssXml(xml, num);

  if (articles.length === 0) {
    return null; // fallback to NewsAPI
  }

  let text = `=== 台灣${catName}新聞 (前${articles.length}則) ===\n`;

  articles.forEach((article, i) => {
    text += `\n${i + 1}. ${article.title}\n`;
    text += `   來源: ${article.source}`;
    if (article.date) text += ` | ${article.date}`;
    text += "\n";
  });

  return { text };
}

/**
 * NewsAPI 備援來源（僅本地開發可用）
 */
async function fetchNewsAPI(cat, num, catName) {
  const url = `https://newsapi.org/v2/top-headlines?country=tw&category=${cat}&pageSize=${num}&apiKey=${config.news.apiKey}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`NewsAPI 回傳 ${res.status}: ${body.slice(0, 100)}`);
  }

  const data = await res.json();
  const articles = data.articles || [];

  if (articles.length === 0) return null;

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

  return { text };
}

module.exports = { isAvailable, getNews, CATEGORY_NAMES };
