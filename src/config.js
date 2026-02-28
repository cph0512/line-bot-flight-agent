require("dotenv").config();

const config = {
  line: {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET,
  },
  // AI 模型（支援 Gemini 或 Anthropic）
  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash-lite",
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
  },
  browser: {
    headless: process.env.BROWSER_HEADLESS !== "false",
    maxPages: parseInt(process.env.BROWSER_MAX_PAGES) || 3,
  },
  // Amadeus API（主要航班資料來源）
  amadeus: {
    clientId: process.env.AMADEUS_CLIENT_ID,
    clientSecret: process.env.AMADEUS_CLIENT_SECRET,
    production: process.env.AMADEUS_PRODUCTION === "true",
  },
  // 里程帳號（選填）
  mileageAccounts: {
    CI: { id: process.env.CI_MEMBER_ID, password: process.env.CI_MEMBER_PASSWORD },
    BR: { id: process.env.BR_MEMBER_ID, password: process.env.BR_MEMBER_PASSWORD },
    JX: { id: process.env.JX_MEMBER_ID, password: process.env.JX_MEMBER_PASSWORD },
    EK: { id: process.env.EK_MEMBER_ID, password: process.env.EK_MEMBER_PASSWORD },
    TK: { id: process.env.TK_MEMBER_ID, password: process.env.TK_MEMBER_PASSWORD },
    CX: { id: process.env.CX_MEMBER_ID, password: process.env.CX_MEMBER_PASSWORD },
    SQ: { id: process.env.SQ_MEMBER_ID, password: process.env.SQ_MEMBER_PASSWORD },
  },
  server: {
    port: process.env.PORT || 3000,
    nodeEnv: process.env.NODE_ENV || "development",
  },
  // 氣象署 CWA Open Data API（選填）
  cwa: {
    apiKey: process.env.CWA_API_KEY,
  },
  // NewsAPI（選填）
  news: {
    apiKey: process.env.NEWS_API_KEY,
  },
  // Google Calendar（選填）
  calendar: {
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    familyCalendars: parseFamilyCalendars(process.env.FAMILY_CALENDARS),
  },
  // RapidAPI（Google Flights 搜尋）
  rapidapi: {
    key: process.env.RAPIDAPI_KEY,
  },
  // 每日晨報（選填）
  briefing: {
    time: process.env.MORNING_BRIEFING_TIME || "07:00",
    timezone: process.env.TZ || "Asia/Taipei",
    recipients: (process.env.BRIEFING_RECIPIENTS || "").split(",").filter(Boolean),
    defaultCity: process.env.DEFAULT_CITY || "臺北市",
    // 多城市天氣，逗號分隔（例如 "桃園,龍潭,台北"）
    cities: (process.env.BRIEFING_CITIES || process.env.DEFAULT_CITY || "臺北市").split(",").map(s => s.trim()).filter(Boolean),
    // 新聞區塊，格式 "region:category:count,..." （例如 "tw:business:3,tw:general:3,world:business:3,world:general:3"）
    newsSections: parseBriefingNews(process.env.BRIEFING_NEWS),
  },
};

/**
 * 解析晨報新聞設定
 * 格式: "region:category:count,..." e.g. "tw:business:3,tw:general:3,world:business:3,world:general:3"
 * 預設: 台灣綜合 5 筆
 */
function parseBriefingNews(str) {
  if (!str) return [{ region: "tw", category: "general", count: 5 }];
  return str.split(",").map((s) => {
    const [region, category, count] = s.trim().split(":");
    return {
      region: region || "tw",
      category: category || "general",
      count: parseInt(count) || 3,
    };
  }).filter((s) => s.region && s.category);
}

/**
 * 解析家庭行事曆設定
 * 格式: "名稱:calendarId,名稱:calendarId"
 */
function parseFamilyCalendars(str) {
  if (!str) return [];
  return str.split(",").map((pair) => {
    const [name, id] = pair.split(":").map((s) => s.trim());
    return { name, id };
  }).filter((c) => c.name && c.id);
}

// 檢查是否為佔位符值
function isPlaceholder(val) {
  if (!val) return true;
  const placeholders = ["your_token", "your_secret", "your_key", "YOUR_", "REPLACE_ME", "xxx", "changeme"];
  return placeholders.some((p) => val.toLowerCase().includes(p.toLowerCase()));
}

function validateConfig() {
  // AI API Key：Gemini 或 Anthropic 至少要有一個
  const hasAiKey = config.gemini.apiKey || config.anthropic.apiKey;
  const required = [
    ["LINE_CHANNEL_ACCESS_TOKEN", config.line.channelAccessToken],
    ["LINE_CHANNEL_SECRET", config.line.channelSecret],
    ["GEMINI_API_KEY 或 ANTHROPIC_API_KEY", hasAiKey ? "ok" : null],
  ];

  const missing = required.filter(([, v]) => !v || isPlaceholder(v));
  if (missing.length > 0) {
    console.error("=".repeat(50));
    console.error("  缺少或無效的環境變數：");
    missing.forEach(([n, v]) => {
      const reason = !v ? "未設定" : "仍為佔位符值";
      console.error(`  - ${n} (${reason})`);
    });
    console.error("");
    console.error("  請在 Railway 環境變數或 .env 中設定真實的值");
    console.error("=".repeat(50));
    process.exit(1);
  }

  // 顯示 AI 設定狀態
  if (config.gemini.apiKey) {
    console.log(`[Config] AI: Gemini (${config.gemini.model})`);
    console.log(`[Config] GEMINI_API_KEY: ${config.gemini.apiKey.slice(0, 12)}...`);
  } else {
    console.log(`[Config] AI: Anthropic (${config.anthropic.model})`);
    console.log(`[Config] ANTHROPIC_API_KEY: ${config.anthropic.apiKey.slice(0, 12)}...`);
  }
  if (config.amadeus.clientId) {
    console.log(`[Config] AMADEUS: ${config.amadeus.production ? "production" : "test"} (已設定)`);
  } else {
    console.log(`[Config] AMADEUS: 未設定（將使用 RPA 爬蟲作為替代）`);
  }

  // 里程帳號提醒
  const noMileage = Object.entries(config.mileageAccounts)
    .filter(([, v]) => !v.id)
    .map(([k]) => k);
  if (noMileage.length > 0) {
    console.log(`[Config] 未設定里程帳號：${noMileage.join(", ")}（只能查現金票）`);
  }

  // 選填模組狀態
  console.log(`[Config] RapidAPI (Google Flights): ${config.rapidapi.key ? "已設定" : "未設定（Google Flights 搜尋停用）"}`);
  console.log(`[Config] CWA 天氣: ${config.cwa.apiKey ? "已設定" : "未設定（天氣功能停用）"}`);
  console.log(`[Config] NewsAPI: ${config.news.apiKey ? "已設定" : "未設定（新聞功能停用）"}`);
  console.log(`[Config] Google Calendar: ${config.calendar.keyFile ? "已設定" : "未設定（行事曆功能停用）"}`);
  if (config.briefing.recipients.length > 0) {
    console.log(`[Config] 每日晨報: ${config.briefing.time} → ${config.briefing.recipients.length} 位接收者`);
  } else {
    console.log(`[Config] 每日晨報: 未設定接收者（晨報功能停用）`);
  }
}

module.exports = { config, validateConfig };
