// =============================================
// AI Agent（全能管家版 v6 — Gemini + Anthropic 自動切換）
//
// 優先使用 Gemini（免費），額度爆掉自動切 Anthropic
// 兩個都沒有 key 才會報錯
// =============================================

const { GoogleGenAI } = require("@google/genai");
const { config } = require("../config");
const { tools: anthropicTools } = require("./tools");
const {
  searchAll,
  searchCashFlights,
  searchMilesFlights,
  formatResultsForAI,
  getBookingLinks,
} = require("../scraper/scraperEngine");
const { weatherService, newsService, calendarService, briefingService, webSearchService, googleFlightsService } = require("../services");
const logger = require("../utils/logger");

// ========== AI Client 初始化（兩個都初始化）==========
let genAI = null;
let anthropic = null;

if (config.gemini.apiKey) {
  genAI = new GoogleGenAI({ apiKey: config.gemini.apiKey });
  logger.info("[AI] Gemini 引擎已初始化");
}
if (config.anthropic.apiKey) {
  const Anthropic = require("@anthropic-ai/sdk").default;
  anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });
  logger.info("[AI] Anthropic 引擎已初始化（備援）");
}

// Gemini 429 冷卻機制
let geminiCooldownUntil = 0; // timestamp，冷卻期間自動切 Anthropic

// ========== 工具定義轉換（Anthropic → Gemini）==========

function toGeminiType(type) {
  if (!type) return "STRING";
  const t = type.toUpperCase();
  const valid = ["STRING", "NUMBER", "INTEGER", "BOOLEAN", "ARRAY", "OBJECT"];
  return valid.includes(t) ? t : "STRING";
}

function convertSchema(schema) {
  if (!schema) return undefined;
  const result = {};
  result.type = toGeminiType(schema.type);
  if (schema.description) result.description = schema.description;
  if (schema.enum) result.enum = schema.enum;
  if (Array.isArray(schema.required)) result.required = schema.required;
  if (schema.properties && Object.keys(schema.properties).length > 0) {
    result.properties = {};
    for (const [key, val] of Object.entries(schema.properties)) {
      const prop = { ...val };
      delete prop.default;
      result.properties[key] = convertSchema(prop);
    }
  }
  if (schema.items) result.items = convertSchema(schema.items);
  return result;
}

function convertToolsToGemini(tools) {
  const declarations = tools.map((t) => {
    const decl = { name: t.name, description: t.description };
    const schema = t.input_schema;
    if (schema && schema.properties && Object.keys(schema.properties).length > 0) {
      decl.parameters = convertSchema(schema);
    }
    return decl;
  });
  logger.info(`[AI] Gemini 工具: ${declarations.map(d => d.name).join(", ")}`);
  // 注意：Gemini 2.5 Flash 不支援 googleSearch + functionDeclarations 混用
  // 搜尋功能改由 search_web 工具（functionDeclarations）處理
  return [
    { functionDeclarations: declarations },
  ];
}

const geminiTools = genAI ? convertToolsToGemini(anthropicTools) : null;

/**
 * 系統提示（精簡版，Gemini 和 Anthropic 共用）
 */
function getSystemPrompt() {
  const today = new Date().toISOString().slice(0, 10);
  const year = new Date().getFullYear();

  return `你是 LINE 全能家庭 AI 管家。用繁體中文回覆，語氣親切，善用 emoji，回覆簡潔適合手機閱讀。
今天：${today}。日期沒年份預設 ${year} 年，已過就用 ${year + 1} 年。

你有三種能力：
1. 專用工具：機票查詢、天氣、新聞、行事曆、晨報
2. 網路搜尋：用 search_web 工具上網查即時資訊（股價、賽程、推薦、任何你不確定的事）
3. 一般聊天：日常對話、問答、建議、翻譯、計算

重要規則：
- 當訊息中附有「網路搜尋結果」，你必須根據搜尋結果回覆，不可以說「查不到」。
- 當你不確定答案或需要即時資訊時，呼叫 search_web 搜尋，不要自己猜。
- 搜尋結果若有數據，直接引用；若搜尋結果不相關，才說「目前查不到確切資訊」。

⚠️ 絕對禁止編造的資料（違反會失去使用者信任）：
- 股價、匯率、基金淨值等金融數據
- 航班價格、機票票價
- 天氣溫度、降雨機率
- 任何「具體數字」：價格、統計數據、排名、比分
如果搜尋不到即時數據，請誠實說「我目前無法查到即時數據」，並建議使用者去哪裡查（如：Yahoo 股市、Google Finance）。
絕對不可以自己編一個看起來合理的數字。

## 工具使用規則
- ✈️ 機票/航班/比價 → 一律用 search_google_flights（Google Flights 即時票價）。禁止使用 search_all_flights / search_cash_only / search_miles_only。
- 不確定機場代碼 → search_airport（用城市名找代碼）
- 找最便宜日期/彈性日期 → get_flight_prices（價格日曆）
- 天氣/溫度/下雨 → get_weather
- 新聞（台灣/國際/科技/財經等）→ get_news
- 行程/行事曆 → get_events
- 早報/晨報/今日摘要/每日簡報 → trigger_briefing
- 加行程/新增會議 → add_event
- 改行程 → 先 get_events 再 update_event
- 刪行程/取消 → 先 get_events 再 delete_event
- 股價/匯率/賽程/活動/推薦/任何需要查證的問題 → search_web

## 航班回覆格式
系統自動產生 Flex 卡片，你只做分析摘要。不要用 markdown 表格。格式：

✈️ 出發地 → 目的地
📅 日期 | 艙等

🏆 推薦：航空 航班號
  └ 出發→抵達 | 直飛/轉機 | 飛行時間
  └ 💰 NT$票價
  └ ✅ 推薦原因

📊 其他：
2️⃣ 航空 航班號 | 時間 | NT$票價

⚠️ 票價來自 Google Flights，僅供參考，實際價格請以航空公司官網為準。

每次航班回覆最後都必須加上這行提醒。

## 新聞回覆格式
不要附連結URL。格式：

📰 地區分類新聞

1️⃣ 標題
📍來源

2️⃣ 標題
📍來源

⭐ 一句焦點總結

## 代碼表
航空：CI=華航 BR=長榮 JX=星宇 EK=阿聯酋 TK=土航 CX=國泰 SQ=新航
城市：台北:TPE 東京:NRT 大阪:KIX 首爾:ICN 曼谷:BKK 新加坡:SIN 香港:HKG 倫敦:LHR 紐約:JFK 洛杉磯:LAX`;
}

// 對話記錄
const conversations = new Map();
const MAX_HISTORY = 20;

// ========== 自動搜尋偵測 ==========
// 偵測需要即時資訊的關鍵字，自動先搜尋再給 AI
const SEARCH_PATTERNS = [
  /股價|股票|漲停|跌停|收盤|開盤|市值|殖利率|本益比/,
  /匯率|換算|美金|日幣|歐元|匯價/,
  /賽程|比賽|開幕|冠軍|世界盃|WBC|奧運|世錦賽|MLB|NBA|英超/,
  /推薦.{0,4}(餐廳|美食|小吃|咖啡)|餐廳.{0,4}推薦|好吃/,
  /推薦.{0,4}(景點|旅遊|飯店|住宿)|景點.{0,4}推薦|好玩/,
  /多少錢|價格|售價|費用|票價|門票/,
  /營業時間|幾點開|幾點關|地址|怎麼去|怎麼走/,
  /電影.*上映|上映.*電影|院線|檔期/,
  /演唱會|展覽|活動.*時間|時間.*活動/,
];

function needsWebSearch(message) {
  return SEARCH_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * 處理使用者訊息 - 主入口（自動切換引擎）
 */
async function handleMessage(userId, userMessage) {
  logger.info(`[AI] === 收到訊息 === userId=${userId.slice(-6)} msg="${userMessage}"`);

  if (!conversations.has(userId)) conversations.set(userId, []);
  const history = conversations.get(userId);
  history.push({ role: "user", content: userMessage });
  while (history.length > MAX_HISTORY) history.shift();

  try {
    // ====== 自動搜尋：偵測到即時資訊需求，先搜再給 AI ======
    let searchHint = "";
    if (needsWebSearch(userMessage)) {
      try {
        logger.info(`[AI] 🔍 偵測到即時資訊需求，自動搜尋: "${userMessage}"`);
        const searchResult = await webSearchService.searchWeb(userMessage, 5);
        if (searchResult?.text) {
          searchHint = `\n\n[以下是網路搜尋結果，請根據這些資料回覆使用者，不要說「查不到」：]\n${searchResult.text}`;
          logger.info(`[AI] 🔍 自動搜尋完成，結果 ${searchResult.text.length} 字`);
        }
      } catch (e) {
        logger.warn(`[AI] 🔍 自動搜尋失敗: ${e.message}`);
      }
    }

    // 暫時把搜尋結果附加到使用者訊息，讓 AI 看到
    if (searchHint) {
      history[history.length - 1].content = userMessage + searchHint;
    }

    // 決定使用哪個引擎
    const now = Date.now();
    const geminiAvailable = genAI && now > geminiCooldownUntil;
    const anthropicAvailable = !!anthropic;
    // Anthropic fallback 開關（環境變數 AI_FALLBACK=true 啟用，預設關閉）
    const fallbackEnabled = process.env.AI_FALLBACK === "true";

    let response;

    if (geminiAvailable) {
      // 先嘗試 Gemini
      try {
        response = await runGeminiLoop(history);
      } catch (error) {
        // 429 或其他 Gemini 錯誤
        if (error.message?.includes("429") || error.message?.includes("RESOURCE_EXHAUSTED") || error.message?.includes("quota")) {
          logger.warn(`[AI] Gemini 額度用完，冷卻 10 分鐘`);
          geminiCooldownUntil = now + 10 * 60 * 1000; // 10 分鐘冷卻

          if (fallbackEnabled && anthropicAvailable) {
            logger.info("[AI] Fallback 已啟用，切換到 Anthropic");
            response = await runAnthropicLoop(history);
          } else {
            return { text: "⚠️ Gemini 免費額度已用完，請稍後再試（約 1 分鐘後重置）。" };
          }
        } else {
          // 其他錯誤
          logger.error(`[AI] Gemini 錯誤: ${error.message}`);
          if (fallbackEnabled && anthropicAvailable) {
            logger.info("[AI] Fallback 已啟用，切換到 Anthropic");
            response = await runAnthropicLoop(history);
          } else {
            return { text: `⚠️ Gemini 處理失敗：${error.message}\n\n請再試一次，或換個方式問問看 🙏` };
          }
        }
      }
    } else if (fallbackEnabled && anthropicAvailable) {
      // Gemini 冷卻中，且 fallback 啟用
      const cooldownRemain = Math.max(0, Math.ceil((geminiCooldownUntil - now) / 1000));
      if (geminiCooldownUntil > now) {
        logger.info(`[AI] Gemini 冷卻中（還剩 ${cooldownRemain}s），使用 Anthropic`);
      }
      response = await runAnthropicLoop(history);
    } else if (geminiCooldownUntil > now) {
      // Gemini 冷卻中，fallback 未啟用
      const cooldownRemain = Math.max(0, Math.ceil((geminiCooldownUntil - now) / 1000));
      return { text: `⚠️ Gemini 冷卻中（還剩 ${cooldownRemain} 秒），請稍後再試。` };
    } else {
      return { text: "未設定任何 AI API Key。請在環境變數設定 GEMINI_API_KEY 或 ANTHROPIC_API_KEY。" };
    }

    // 還原使用者訊息（移除搜尋結果，避免污染對話記錄）
    if (searchHint) {
      history[history.length - 1].content = userMessage;
    }

    history.push({ role: "assistant", content: response.text });
    logger.info(`[AI] === 回覆完成 === flights=${response.flights?.length || 0} textLen=${response.text?.length || 0}`);
    return response;
  } catch (error) {
    // 還原使用者訊息
    if (searchHint) {
      const lastUserIdx = history.findLastIndex((m) => m.role === "user");
      if (lastUserIdx >= 0) history[lastUserIdx].content = userMessage;
    }
    logger.error("[AI] handleMessage 失敗", { error: error.message, stack: error.stack });
    return { text: `抱歉，系統發生錯誤：${error.message}\n請稍後再試！` };
  }
}

// ================================================================
// Gemini Agent Loop
// ================================================================
async function runGeminiLoop(history) {
  let iterations = 5;
  let lastFlights = null;
  let lastInboundFlights = null;

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("AI 處理超時（55 秒）")), 55000)
  );

  const agentWork = async () => {
    const contents = history.map((msg) => ({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content }],
    }));

    const geminiConfig = {
      systemInstruction: getSystemPrompt(),
      tools: geminiTools,
      toolConfig: {
        functionCallingConfig: {
          mode: "AUTO",
        },
      },
    };

    logger.info(`[AI] Gemini (${config.gemini.model}) contents=${contents.length}`);

    while (iterations-- > 0) {
      let response;
      try {
        response = await genAI.models.generateContent({
          model: config.gemini.model,
          contents,
          config: geminiConfig,
        });
      } catch (e) {
        // 429 錯誤往上拋，讓 handleMessage 處理 fallback
        logger.error(`[AI] Gemini API 錯誤: ${e.message}`);
        throw e;
      }

      const functionCalls = response.functionCalls || [];

      // 檢查 Google Search grounding
      const candidate = response.candidates?.[0];
      const grounding = candidate?.groundingMetadata;
      const searchQueries = grounding?.webSearchQueries || [];
      const groundingChunks = grounding?.groundingChunks || [];
      const wasGrounded = groundingChunks.length > 0;

      // 記錄 token 用量
      const gemUsage = response.usageMetadata || {};
      logger.info(`[AI] Gemini 回應: functionCalls=${functionCalls.length} hasText=${!!response.text} grounded=${wasGrounded} searchQueries=${JSON.stringify(searchQueries)} | tokens: in=${gemUsage.promptTokenCount || "?"} out=${gemUsage.candidatesTokenCount || "?"} total=${gemUsage.totalTokenCount || "?"}`);

      if (functionCalls.length === 0) {
        let text = response.text || "抱歉，我不太理解。試試：「台灣新聞」「台北天氣」「晨報」";

        // 如果有 Google Search grounding，附上來源
        if (wasGrounded && groundingChunks.length > 0) {
          const sources = groundingChunks
            .filter(c => c.web?.title)
            .map(c => c.web.title)
            .slice(0, 3);
          if (sources.length > 0) {
            text += `\n\n📎 資料來源：${sources.join("、")}`;
          }
        }

        return { text, flights: lastFlights, inboundFlights: lastInboundFlights };
      }

      if (response.candidates?.[0]?.content) {
        contents.push(response.candidates[0].content);
      }

      const functionResponseParts = [];
      for (const fc of functionCalls) {
        logger.info(`[AI] >>> 工具: ${fc.name}`, { args: JSON.stringify(fc.args) });
        const startTime = Date.now();
        const result = await executeTool(fc.name, fc.args || {});
        logger.info(`[AI] <<< 完成: ${fc.name} (${Date.now() - startTime}ms)`);

        if (result.flights?.length > 0) lastFlights = result.flights;
        if (result.inboundFlights?.length > 0) lastInboundFlights = result.inboundFlights;

        functionResponseParts.push({
          functionResponse: {
            name: fc.name,
            response: { result: typeof result.text === "string" ? result.text : JSON.stringify(result.text) },
          },
        });
      }

      contents.push({ role: "user", parts: functionResponseParts });
    }

    return { text: "查詢太複雜了，試試：「台北飛東京 3/15-3/20」" };
  };

  return Promise.race([agentWork(), timeout]);
}

// ================================================================
// Anthropic Agent Loop
// ================================================================
async function runAnthropicLoop(history) {
  const messages = [...history];
  let iterations = 5;
  let lastFlights = null;
  let lastInboundFlights = null;

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("AI 處理超時（55 秒）")), 55000)
  );

  const agentWork = async () => {
    while (iterations-- > 0) {
      logger.info(`[AI] Anthropic (${config.anthropic.model}) 迴圈=${iterations + 1}`);

      const res = await anthropic.messages.create({
        model: config.anthropic.model,
        max_tokens: 2000,
        system: getSystemPrompt(),
        tools: anthropicTools,
        messages,
      });

      // 記錄 token 用量
      const usage = res.usage || {};
      logger.info(`[AI] Anthropic 回應: stop_reason=${res.stop_reason} | tokens: in=${usage.input_tokens || "?"} out=${usage.output_tokens || "?"} total=${(usage.input_tokens || 0) + (usage.output_tokens || 0)}`);

      if (res.stop_reason === "end_turn") {
        const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
        return { text, flights: lastFlights, inboundFlights: lastInboundFlights };
      }

      if (res.stop_reason === "tool_use") {
        messages.push({ role: "assistant", content: res.content });
        const toolResults = [];

        for (const tu of res.content.filter((b) => b.type === "tool_use")) {
          logger.info(`[AI] >>> 工具: ${tu.name}`);
          const startTime = Date.now();
          const result = await executeTool(tu.name, tu.input);
          logger.info(`[AI] <<< 完成: ${tu.name} (${Date.now() - startTime}ms)`);

          if (result.flights?.length > 0) lastFlights = result.flights;
          if (result.inboundFlights?.length > 0) lastInboundFlights = result.inboundFlights;

          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: typeof result.text === "string" ? result.text : JSON.stringify(result.text),
          });
        }

        messages.push({ role: "user", content: toolResults });
        continue;
      }

      const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n")
        || "可以再說清楚一點嗎？";
      return { text, flights: lastFlights, inboundFlights: lastInboundFlights };
    }

    return { text: "查詢太複雜了，試試：「台北飛東京 3/15-3/20」" };
  };

  return Promise.race([agentWork(), timeout]);
}

// ================================================================
// 執行工具（共用）
// ================================================================
async function executeTool(name, input) {
  logger.info(`[Tool] ${name}`, { input: JSON.stringify(input) });

  const flightTools = ["search_all_flights", "search_cash_only", "search_miles_only", "get_booking_links"];
  if (flightTools.includes(name)) {
    const params = {
      origin: input.origin,
      destination: input.destination,
      departDate: input.departDate,
      returnDate: input.returnDate || null,
      adults: input.adults || 1,
      cabinClass: input.cabinClass || null,
    };
    const airlines = input.airlines || [];

    switch (name) {
      case "search_all_flights": {
        try {
          const result = await searchAll(params, airlines);
          const text = formatResultsForAI(result);
          const { outbound, inbound } = extractFlightsForFlex(result);
          return { text, flights: outbound, inboundFlights: inbound };
        } catch (e) {
          logger.error(`[Tool] search_all 失敗: ${e.message}`);
          return { text: `搜尋失敗：${e.message}` };
        }
      }
      case "search_cash_only": {
        try {
          const result = await searchCashFlights(params, airlines);
          const text = formatResultsForAI(result);
          return { text, flights: result.flights || [], inboundFlights: result.inboundFlights || [] };
        } catch (e) {
          return { text: `現金票搜尋失敗：${e.message}` };
        }
      }
      case "search_miles_only": {
        try {
          const result = await searchMilesFlights(params, airlines);
          const text = formatResultsForAI(result);
          return { text, flights: [] };
        } catch (e) {
          return { text: `里程票搜尋失敗：${e.message}` };
        }
      }
      case "get_booking_links": {
        const links = getBookingLinks(params);
        return { text: links.map((l) => `${l.airline}: ${l.url}`).join("\n") };
      }
    }
  }

  if (name === "get_weather") {
    return await weatherService.getWeather(input.city, input.days || 1);
  }

  if (name === "get_news") {
    return await newsService.getNews(input.category || "general", input.count || 7, input.region || "tw");
  }

  if (name === "get_events") {
    if (!calendarService.isAvailable()) return { text: "行事曆功能未啟用（未設定 Google Calendar）。" };
    return await calendarService.getEvents(input.calendarName, input.startDate, input.endDate);
  }
  if (name === "add_event") {
    if (!calendarService.isAvailable()) return { text: "行事曆功能未啟用。" };
    return await calendarService.addEvent(input.calendarName, input.summary, input.startTime, input.endTime, input.description);
  }
  if (name === "update_event") {
    if (!calendarService.isAvailable()) return { text: "行事曆功能未啟用。" };
    const updates = {};
    if (input.summary) updates.summary = input.summary;
    if (input.startTime) updates.startTime = input.startTime;
    if (input.endTime) updates.endTime = input.endTime;
    if (input.description) updates.description = input.description;
    return await calendarService.updateEvent(input.eventId, input.calendarName, updates);
  }
  if (name === "delete_event") {
    if (!calendarService.isAvailable()) return { text: "行事曆功能未啟用。" };
    return await calendarService.deleteEvent(input.eventId, input.calendarName);
  }

  if (name === "trigger_briefing") {
    if (!briefingService.isAvailable()) return { text: "每日晨報功能未啟用（未設定 BRIEFING_RECIPIENTS）。" };
    try {
      await briefingService.triggerBriefing();
      return { text: "已成功推送今日晨報！請查看 LINE 訊息。" };
    } catch (e) {
      return { text: `晨報推送失敗：${e.message}` };
    }
  }

  // ====== Google Flights 工具 ======
  if (name === "search_google_flights") {
    if (!googleFlightsService.isAvailable()) {
      return { text: "Google Flights 搜尋未啟用（未設定 RAPIDAPI_KEY）。可改用 search_all_flights 查詢 Amadeus 資料。" };
    }
    try {
      const result = await googleFlightsService.searchFlights({
        origin: input.origin,
        destination: input.destination,
        departDate: input.departDate,
        returnDate: input.returnDate || null,
        adults: input.adults || 1,
        children: input.children || 0,
        cabinClass: input.cabinClass || "ECONOMY",
      });
      return { text: result.text, flights: result.flights || [] };
    } catch (e) {
      logger.error(`[Tool] search_google_flights 失敗: ${e.message}`);
      return { text: `Google Flights 搜尋失敗：${e.message}。可改用 search_all_flights 查詢。` };
    }
  }

  if (name === "search_airport") {
    if (!googleFlightsService.isAvailable()) {
      return { text: "機場搜尋未啟用（未設定 RAPIDAPI_KEY）。常用代碼：TPE=桃園, NRT=東京成田, KIX=大阪關西, ICN=首爾仁川, BKK=曼谷" };
    }
    try {
      return await googleFlightsService.searchAirport(input.query);
    } catch (e) {
      logger.error(`[Tool] search_airport 失敗: ${e.message}`);
      return { text: `機場搜尋失敗：${e.message}` };
    }
  }

  if (name === "get_flight_prices") {
    if (!googleFlightsService.isAvailable()) {
      return { text: "價格日曆未啟用（未設定 RAPIDAPI_KEY）。" };
    }
    try {
      return await googleFlightsService.getPriceCalendar({
        origin: input.origin,
        destination: input.destination,
        departDate: input.departDate,
        returnDate: input.returnDate || null,
      });
    } catch (e) {
      logger.error(`[Tool] get_flight_prices 失敗: ${e.message}`);
      return { text: `價格日曆查詢失敗：${e.message}` };
    }
  }

  if (name === "search_web") {
    try {
      return await webSearchService.searchWeb(input.query, input.count || 5);
    } catch (e) {
      logger.error(`[Tool] search_web 失敗: ${e.message}`);
      return { text: `網路搜尋失敗：${e.message}。建議到 Google 搜尋：https://www.google.com/search?q=${encodeURIComponent(input.query || "")}` };
    }
  }

  return { text: `未知工具：${name}` };
}

function extractFlightsForFlex(result) {
  const outbound = [];
  const inbound = [];
  if (result.cash?.flights?.length > 0) outbound.push(...result.cash.flights);
  if (result.inbound?.length > 0) inbound.push(...result.inbound);
  else if (result.cash?.inboundFlights?.length > 0) inbound.push(...result.cash.inboundFlights);
  return { outbound: outbound.slice(0, 10), inbound: inbound.slice(0, 10) };
}

function clearHistory(userId) {
  conversations.delete(userId);
}

module.exports = { handleMessage, clearHistory };
