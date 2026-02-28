// =============================================
// 新聞服務 — Google News RSS（免費、無限制）
//
// 台灣新聞：Google News TW RSS
// 國際新聞：Google News US RSS（英文）
// 內建 10 分鐘快取
// =============================================

const logger = require("../utils/logger");
const { config } = require("../config");

const VALID_CATEGORIES = ["general", "business", "technology", "sports", "entertainment", "health", "science"];

const CATEGORY_NAMES = {
  general: "綜合", business: "財經", technology: "科技",
  sports: "體育", entertainment: "娛樂", health: "健康", science: "科學",
};

// Google News RSS topic IDs（台灣版 TW:zh-Hant）
const GOOGLE_NEWS_TOPICS_TW = {
  general: "CAAqJggKIiBDQkFTRWdvSUwyMHZNRFZxYUdjU0FucG9HZ0pVVnlnQVAB",
  business: "CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FucG9HZ0pVVnlnQVAB",
  technology: "CAAqJggKIiBDQkFTRWdvSUwyMHZNRGRqTVhZU0FucG9HZ0pVVnlnQVAB",
  sports: "CAAqJggKIiBDQkFTRWdvSUwyMHZNRFp1ZEdvU0FucG9HZ0pVVnlnQVAB",
  entertainment: "CAAqJggKIiBDQkFTRWdvSUwyMHZNREpxYW5RU0FucG9HZ0pVVnlnQVAB",
  health: "CAAqIQgKIhtDQkFTRGdvSUwyMHZNR3QwTlRFU0FucG9LQUFQAQ",
  science: "CAAqJggKIiBDQkFTRWdvSUwyMHZNRFp0Y1RjU0FucG9HZ0pVVnlnQVAB",
};

// Google News RSS topic IDs（國際版 US:en）
const GOOGLE_NEWS_TOPICS_WORLD = {
  general: "CAAqJggKIiBDQkFTRWdvSUwyMHZNRFZxYUdjU0FtVnVHZ0pWVXlnQVAB",
  business: "CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtVnVHZ0pWVXlnQVAB",
  technology: "CAAqJggKIiBDQkFTRWdvSUwyMHZNRGRqTVhZU0FtVnVHZ0pWVXlnQVAB",
  sports: "CAAqJggKIiBDQkFTRWdvSUwyMHZNRFp1ZEdvU0FtVnVHZ0pWVXlnQVAB",
  entertainment: "CAAqJggKIiBDQkFTRWdvSUwyMHZNREpxYW5RU0FtVnVHZ0pWVXlnQVAB",
  health: "CAAqIQgKIhtDQkFTRGdvSUwyMHZNR3QwTlRFU0FtVnVLQUFQAQ",
  science: "CAAqJggKIiBDQkFTRWdvSUwyMHZNRFp0Y1RjU0FtVnVHZ0pWVXlnQVAB",
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

    // <link> 是 Google News 轉址 URL（會導向真正文章）
    const linkMatch = item.match(/<link>(.*?)<\/link>/) || item.match(/<link><!\[CDATA\[(.*?)\]\]><\/link>/);
    const rawLink = linkMatch ? (linkMatch[1] || "").trim() : "";

    // <source url="..."> 只是新聞來源的首頁（例如 https://udn.com），不是文章連結
    // 只在 <link> 不存在時才 fallback
    const sourceUrlMatch = item.match(/<source[^>]+url=["']([^"']+)["']/);
    const sourceUrl = sourceUrlMatch ? sourceUrlMatch[1].trim() : "";

    // 優先使用 <link>（實際文章連結），<source url> 只是首頁
    const link = rawLink || sourceUrl;

    const pubDateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);
    const pubDate = pubDateMatch ? pubDateMatch[1].trim() : "";

    // 跳過空標題或 "[Removed]" 類的無效文章
    if (!title || title === "[Removed]") continue;

    // 清理標題（Google News 格式：「標題 - 來源」）
    const cleanTitle = title.replace(/\s*-\s*[^-]+$/, "").trim() || title;

    articles.push({
      title: cleanTitle,
      source: source || extractSourceFromTitle(title),
      link,
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
 * @param {string} region - 地區："tw"=台灣, "world"=國際
 */
async function getNews(category, count = 5, region = "tw") {
  const cat = VALID_CATEGORIES.includes(category) ? category : "general";
  const num = Math.min(Math.max(count, 1), 10);
  const catName = CATEGORY_NAMES[cat];
  const isWorld = region === "world";
  const regionLabel = isWorld ? "國際" : "台灣";

  logger.info(`[News] 查詢 ${regionLabel}${catName} 新聞 ${num} 筆`);

  // 檢查快取
  const cacheKey = `${region}:${cat}:${num}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    logger.info(`[News] 使用快取（${Math.round((Date.now() - cached.time) / 1000)}秒前）`);
    return cached.result;
  }

  // Google News RSS
  try {
    const result = await fetchGoogleNews(cat, num, catName, isWorld);
    if (result) {
      cache.set(cacheKey, { time: Date.now(), result });
      return result;
    }
  } catch (error) {
    logger.error(`[News] Google News RSS 失敗: ${error.message}`);
  }

  // 備援：NewsAPI（僅台灣，且僅本地可用）
  if (!isWorld && config.news?.apiKey) {
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

  return { text: `${regionLabel}新聞查詢失敗，請稍後再試。` };
}

/**
 * Google News RSS 來源
 */
async function fetchGoogleNews(cat, num, catName, isWorld = false) {
  let url;

  if (isWorld) {
    // 國際新聞（英文 US 版）
    const topicId = GOOGLE_NEWS_TOPICS_WORLD[cat];
    url = topicId
      ? `https://news.google.com/rss/topics/${topicId}?hl=en&gl=US&ceid=US:en`
      : `https://news.google.com/rss?hl=en&gl=US&ceid=US:en`;
  } else {
    // 台灣新聞
    const topicId = GOOGLE_NEWS_TOPICS_TW[cat];
    url = topicId
      ? `https://news.google.com/rss/topics/${topicId}?hl=zh-TW&gl=TW&ceid=TW:zh-Hant`
      : `https://news.google.com/rss?hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
  }

  const regionLabel = isWorld ? "國際" : "台灣";
  logger.info(`[News] 呼叫 Google News RSS (${regionLabel}): ${cat}`);

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
    return null;
  }

  let text = `=== ${regionLabel}${catName}新聞 (前${articles.length}則) ===\n`;

  articles.forEach((article, i) => {
    text += `\n${i + 1}. ${article.title}\n`;
    text += `   來源: ${article.source}`;
    if (article.date) text += ` | ${article.date}`;
    text += "\n";
    if (article.link) text += `   🔗 ${article.link}\n`;
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
