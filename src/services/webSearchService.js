// =============================================
// 網路搜尋服務 — DuckDuckGo HTML 搜尋
//
// 免費、無需 API Key、無配額限制
// 解析 DuckDuckGo HTML 結果頁，回傳前幾筆摘要
// =============================================

const logger = require("../utils/logger");

/**
 * 搜尋網路（DuckDuckGo）
 * @param {string} query - 搜尋關鍵字
 * @param {number} count - 回傳筆數（1-8），預設 5
 * @returns {{ text: string }}
 */
async function searchWeb(query, count = 5) {
  if (!query || query.trim().length === 0) {
    return { text: "請提供搜尋關鍵字。" };
  }

  const num = Math.min(Math.max(count, 1), 8);
  logger.info(`[WebSearch] 搜尋: "${query}" (${num} 筆)`);

  try {
    // DuckDuckGo HTML Lite 搜尋
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; LineBot/1.0)",
        "Accept": "text/html",
        "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      throw new Error(`DuckDuckGo 回傳 ${res.status}`);
    }

    const html = await res.text();
    const results = parseDuckDuckGoHTML(html, num);

    if (results.length === 0) {
      return { text: `搜尋「${query}」沒有找到結果。` };
    }

    let text = `=== 網路搜尋「${query}」(前${results.length}筆) ===\n`;
    results.forEach((r, i) => {
      text += `\n${i + 1}. ${r.title}\n`;
      text += `   ${r.snippet}\n`;
      if (r.url) text += `   🔗 ${r.url}\n`;
    });

    logger.info(`[WebSearch] 找到 ${results.length} 筆結果`);
    return { text };
  } catch (error) {
    logger.error(`[WebSearch] 搜尋失敗: ${error.message}`);

    // Fallback: 嘗試 DuckDuckGo Instant Answer API
    try {
      return await searchInstantAnswer(query);
    } catch (e2) {
      logger.error(`[WebSearch] Instant Answer 也失敗: ${e2.message}`);
      return { text: `網路搜尋失敗：${error.message}。請稍後再試。` };
    }
  }
}

/**
 * 解析 DuckDuckGo HTML 搜尋結果
 */
function parseDuckDuckGoHTML(html, count) {
  const results = [];

  // DuckDuckGo HTML Lite 結果格式：
  // <a class="result__a" href="...">Title</a>
  // <a class="result__snippet" href="...">Snippet</a>
  // 或 <td> 結構中包含連結和摘要

  // 方法 1：匹配 result__a 和 result__snippet（標準格式）
  const resultBlockRegex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = resultBlockRegex.exec(html)) !== null && results.length < count) {
    const url = decodeDDGUrl(match[1]);
    const title = stripHTML(match[2]).trim();
    const snippet = stripHTML(match[3]).trim();

    if (title && snippet && !title.includes("Ad")) {
      results.push({ title, snippet, url });
    }
  }

  // 方法 2：如果方法 1 沒結果，嘗試更寬鬆的匹配
  if (results.length === 0) {
    const linkRegex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

    const links = [];
    const snippets = [];

    while ((match = linkRegex.exec(html)) !== null) {
      links.push({ url: decodeDDGUrl(match[1]), title: stripHTML(match[2]).trim() });
    }
    while ((match = snippetRegex.exec(html)) !== null) {
      snippets.push(stripHTML(match[1]).trim());
    }

    for (let i = 0; i < Math.min(links.length, count); i++) {
      if (links[i].title && !links[i].title.includes("Ad")) {
        results.push({
          title: links[i].title,
          snippet: snippets[i] || "",
          url: links[i].url,
        });
      }
    }
  }

  // 方法 3：最寬鬆的匹配（純文字結果）
  if (results.length === 0) {
    const textResultRegex = /<td[^>]*class="result-link"[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/td>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/gi;
    while ((match = textResultRegex.exec(html)) !== null && results.length < count) {
      const url = decodeDDGUrl(match[1]);
      const title = stripHTML(match[2]).trim();
      const snippet = stripHTML(match[3]).trim();
      if (title) {
        results.push({ title, snippet: snippet || "（無摘要）", url });
      }
    }
  }

  return results;
}

/**
 * DuckDuckGo 的 URL 是 redirect 格式，需要解碼
 * 格式：//duckduckgo.com/l/?uddg=https%3A%2F%2Freal-url.com&rut=...
 */
function decodeDDGUrl(rawUrl) {
  if (!rawUrl) return "";
  try {
    if (rawUrl.includes("uddg=")) {
      const match = rawUrl.match(/uddg=([^&]+)/);
      if (match) return decodeURIComponent(match[1]);
    }
    // 已經是正常 URL
    if (rawUrl.startsWith("http")) return rawUrl;
    if (rawUrl.startsWith("//")) return "https:" + rawUrl;
    return rawUrl;
  } catch {
    return rawUrl;
  }
}

/**
 * 移除 HTML 標籤
 */
function stripHTML(html) {
  if (!html) return "";
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * DuckDuckGo Instant Answer API（備援）
 */
async function searchInstantAnswer(query) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; LineBot/1.0)" },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) throw new Error(`Instant Answer API 回傳 ${res.status}`);

  const data = await res.json();

  let text = `=== 搜尋「${query}」===\n`;

  // Abstract（維基百科等摘要）
  if (data.Abstract) {
    text += `\n📖 ${data.AbstractSource || "摘要"}：\n${data.Abstract}\n`;
    if (data.AbstractURL) text += `🔗 ${data.AbstractURL}\n`;
  }

  // Answer（直接答案）
  if (data.Answer) {
    text += `\n💡 答案：${data.Answer}\n`;
  }

  // Related Topics
  if (data.RelatedTopics && data.RelatedTopics.length > 0) {
    text += `\n📌 相關：\n`;
    data.RelatedTopics.slice(0, 3).forEach((topic) => {
      if (topic.Text) {
        text += `- ${topic.Text.slice(0, 100)}\n`;
      }
    });
  }

  if (text === `=== 搜尋「${query}」===\n`) {
    return { text: `搜尋「${query}」沒有找到明確結果。建議到 Google 搜尋：https://www.google.com/search?q=${encodeURIComponent(query)}` };
  }

  return { text };
}

function isAvailable() {
  return true; // 不需 API Key，永遠可用
}

module.exports = { searchWeb, isAvailable };
