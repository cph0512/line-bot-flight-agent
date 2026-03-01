// =============================================
// 網路搜尋服務 — 多引擎搜尋（Google → DuckDuckGo → Fallback）
//
// 免費、無需 API Key
// 依序嘗試多個搜尋引擎，確保雲端部署也能搜尋
// =============================================

const logger = require("../utils/logger");

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * 搜尋網路（多引擎）
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

  // 引擎 1: Google
  try {
    const results = await searchGoogle(query, num);
    if (results.length > 0) {
      logger.info(`[WebSearch] Google 找到 ${results.length} 筆結果`);
      return { text: formatResults(query, results) };
    }
  } catch (e) {
    logger.warn(`[WebSearch] Google 搜尋失敗: ${e.message}`);
  }

  // 引擎 2: DuckDuckGo HTML
  try {
    const results = await searchDuckDuckGo(query, num);
    if (results.length > 0) {
      logger.info(`[WebSearch] DuckDuckGo 找到 ${results.length} 筆結果`);
      return { text: formatResults(query, results) };
    }
  } catch (e) {
    logger.warn(`[WebSearch] DuckDuckGo 搜尋失敗: ${e.message}`);
  }

  // 引擎 3: DuckDuckGo Instant Answer API
  try {
    const result = await searchInstantAnswer(query);
    if (result) {
      logger.info(`[WebSearch] Instant Answer 有結果`);
      return { text: result };
    }
  } catch (e) {
    logger.warn(`[WebSearch] Instant Answer 失敗: ${e.message}`);
  }

  logger.warn(`[WebSearch] 所有引擎都無法搜尋: "${query}"`);
  return {
    text: `搜尋「${query}」暫時無法取得結果。建議到 Google 搜尋：https://www.google.com/search?q=${encodeURIComponent(query)}`,
  };
}

// ========== Google 搜尋 ==========
async function searchGoogle(query, count) {
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=zh-TW&gl=tw&num=${count + 2}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": BROWSER_UA,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) throw new Error(`Google 回傳 ${res.status}`);

  const html = await res.text();

  // 偵測是否被擋
  if (
    html.includes("unusual traffic") ||
    html.includes("captcha") ||
    html.includes("sorry/index")
  ) {
    throw new Error("Google 偵測到異常流量");
  }

  return parseGoogleHTML(html, count);
}

/**
 * 解析 Google 搜尋結果 HTML
 * Google 的結構經常變，這裡用多種方法嘗試
 */
function parseGoogleHTML(html, count) {
  const results = [];

  // 方法 1: 找 <h3> 標題 + 附近的摘要文字
  // Google 結構: <a href="/url?q=REAL_URL"><h3>Title</h3></a> ... <div>snippet</div>
  const blockRegex =
    /<a[^>]+href="\/url\?q=([^"&]+)[^"]*"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<\/a>([\s\S]*?)(?=<a[^>]+href="\/url|$)/gi;
  let match;

  while (
    (match = blockRegex.exec(html)) !== null &&
    results.length < count
  ) {
    const url = decodeURIComponent(match[1]);
    const title = stripHTML(match[2]).trim();
    const afterBlock = match[3];

    // 從 afterBlock 中提取摘要（通常在 <span> 或 <div> 中）
    let snippet = "";
    const spanMatch = afterBlock.match(
      /<span[^>]*class="[^"]*"[^>]*>([\s\S]{20,300}?)<\/span>/i
    );
    if (spanMatch) {
      snippet = stripHTML(spanMatch[1]).trim();
    }
    if (!snippet) {
      // 備用：取 afterBlock 中最長的純文字段落
      const textChunks = stripHTML(afterBlock)
        .split(/\s{3,}/)
        .filter((t) => t.length > 20);
      if (textChunks.length > 0) {
        snippet = textChunks[0].slice(0, 200);
      }
    }

    if (title && url.startsWith("http") && !isAdUrl(url)) {
      results.push({ title, snippet: snippet || "（無摘要）", url });
    }
  }

  // 方法 2: 更簡單的 <h3> 匹配
  if (results.length === 0) {
    const h3Regex =
      /<a[^>]+href="([^"]*)"[^>]*>[^<]*<h3[^>]*>([\s\S]*?)<\/h3>/gi;
    while (
      (match = h3Regex.exec(html)) !== null &&
      results.length < count
    ) {
      let url = match[1];
      if (url.includes("/url?q=")) {
        const qMatch = url.match(/\/url\?q=([^&]+)/);
        if (qMatch) url = decodeURIComponent(qMatch[1]);
      }
      const title = stripHTML(match[2]).trim();
      if (title && url.startsWith("http") && !isAdUrl(url)) {
        results.push({ title, snippet: "", url });
      }
    }
  }

  // 方法 3: 抓取所有看起來像搜尋結果的連結
  if (results.length === 0) {
    const linkRegex =
      /<a[^>]+href="\/url\?q=([^"&]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    while (
      (match = linkRegex.exec(html)) !== null &&
      results.length < count
    ) {
      const url = decodeURIComponent(match[1]);
      const inner = stripHTML(match[2]).trim();
      if (inner.length > 5 && url.startsWith("http") && !isAdUrl(url)) {
        results.push({ title: inner.slice(0, 100), snippet: "", url });
      }
    }
  }

  return results;
}

function isAdUrl(url) {
  return (
    url.includes("googleadservices") ||
    url.includes("google.com/aclk") ||
    url.includes("ad_type=")
  );
}

// ========== DuckDuckGo HTML 搜尋 ==========
async function searchDuckDuckGo(query, count) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": BROWSER_UA,
      Accept: "text/html",
      "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok && res.status !== 202) {
    throw new Error(`DuckDuckGo 回傳 ${res.status}`);
  }

  const html = await res.text();

  // 偵測 CAPTCHA
  if (html.includes("anomaly-modal") || html.includes("bots use DuckDuckGo")) {
    throw new Error("DuckDuckGo CAPTCHA 驗證");
  }

  return parseDuckDuckGoHTML(html, count);
}

function parseDuckDuckGoHTML(html, count) {
  const results = [];
  let match;

  // 方法 1：result__a + result__snippet
  const blockRegex =
    /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  while (
    (match = blockRegex.exec(html)) !== null &&
    results.length < count
  ) {
    const url = decodeDDGUrl(match[1]);
    const title = stripHTML(match[2]).trim();
    const snippet = stripHTML(match[3]).trim();
    if (title && snippet && !title.includes("Ad")) {
      results.push({ title, snippet, url });
    }
  }

  // 方法 2：分開匹配
  if (results.length === 0) {
    const linkRegex =
      /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRegex =
      /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    const links = [];
    const snippets = [];
    while ((match = linkRegex.exec(html)) !== null) {
      links.push({
        url: decodeDDGUrl(match[1]),
        title: stripHTML(match[2]).trim(),
      });
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

  return results;
}

function decodeDDGUrl(rawUrl) {
  if (!rawUrl) return "";
  try {
    if (rawUrl.includes("uddg=")) {
      const match = rawUrl.match(/uddg=([^&]+)/);
      if (match) return decodeURIComponent(match[1]);
    }
    if (rawUrl.startsWith("http")) return rawUrl;
    if (rawUrl.startsWith("//")) return "https:" + rawUrl;
    return rawUrl;
  } catch {
    return rawUrl;
  }
}

// ========== DuckDuckGo Instant Answer API ==========
async function searchInstantAnswer(query) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;

  const res = await fetch(url, {
    headers: { "User-Agent": BROWSER_UA },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) throw new Error(`Instant Answer API 回傳 ${res.status}`);

  const data = await res.json();
  let text = "";

  if (data.Abstract) {
    text += `📖 ${data.AbstractSource || "摘要"}：${data.Abstract}\n`;
  }
  if (data.Answer) {
    text += `💡 答案：${data.Answer}\n`;
  }
  if (data.RelatedTopics?.length > 0) {
    text += `\n📌 相關：\n`;
    data.RelatedTopics.slice(0, 3).forEach((topic) => {
      if (topic.Text) text += `- ${topic.Text.slice(0, 100)}\n`;
    });
  }

  return text.length > 0 ? `=== 搜尋「${query}」===\n${text}` : null;
}

// ========== 共用函式 ==========
function formatResults(query, results) {
  let text = `=== 網路搜尋「${query}」(前${results.length}筆) ===\n`;
  results.forEach((r, i) => {
    text += `\n${i + 1}. ${r.title}\n`;
    if (r.snippet) text += `   ${r.snippet}\n`;
    if (r.url) text += `   🔗 ${r.url}\n`;
  });
  return text;
}

function stripHTML(html) {
  if (!html) return "";
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#\d+;/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isAvailable() {
  return true;
}

module.exports = { searchWeb, isAvailable };
