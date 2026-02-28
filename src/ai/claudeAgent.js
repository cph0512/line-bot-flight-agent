// =============================================
// AI Agent（全能管家版 v5 — Gemini 優化版）
//
// 核心改進：
// - 精簡 system prompt（Gemini 偏好短指令）
// - 明確 toolConfig 確保 function calling 啟用
// - Schema 轉換支援 INTEGER 型別
// - 加強 debug logging
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
const { weatherService, newsService, calendarService, briefingService } = require("../services");
const logger = require("../utils/logger");

// ========== AI Client 初始化 ==========
const useGemini = !!config.gemini.apiKey;
let genAI = null;
let anthropic = null;

if (useGemini) {
  genAI = new GoogleGenAI({ apiKey: config.gemini.apiKey });
  logger.info("[AI] 使用 Gemini 引擎");
} else {
  const Anthropic = require("@anthropic-ai/sdk").default;
  anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });
  logger.info("[AI] 使用 Anthropic 引擎");
}

// ========== 工具定義轉換（Anthropic → Gemini）==========

/**
 * 轉換 Schema type 為 Gemini 格式
 * Gemini 支援：STRING, NUMBER, INTEGER, BOOLEAN, ARRAY, OBJECT
 */
function toGeminiType(type) {
  if (!type) return "STRING";
  const t = type.toUpperCase();
  // 確保是 Gemini 支援的型別
  const valid = ["STRING", "NUMBER", "INTEGER", "BOOLEAN", "ARRAY", "OBJECT"];
  return valid.includes(t) ? t : "STRING";
}

function convertSchema(schema) {
  if (!schema) return undefined;
  const result = {};

  result.type = toGeminiType(schema.type);
  if (schema.description) result.description = schema.description;
  if (schema.enum) result.enum = schema.enum;

  // required 必須是陣列
  if (Array.isArray(schema.required)) {
    result.required = schema.required;
  }

  // 遞迴轉換 properties
  if (schema.properties && Object.keys(schema.properties).length > 0) {
    result.properties = {};
    for (const [key, val] of Object.entries(schema.properties)) {
      const prop = { ...val };
      delete prop.default; // Gemini 不支援 default
      result.properties[key] = convertSchema(prop);
    }
  }

  // Array items
  if (schema.items) {
    result.items = convertSchema(schema.items);
  }

  return result;
}

function convertToolsToGemini(tools) {
  const declarations = [];

  for (const t of tools) {
    const decl = {
      name: t.name,
      description: t.description,
    };

    const schema = t.input_schema;
    if (schema && schema.properties && Object.keys(schema.properties).length > 0) {
      decl.parameters = convertSchema(schema);
    }

    declarations.push(decl);
  }

  logger.info(`[AI] 轉換工具定義: ${declarations.map(d => d.name).join(", ")} (共 ${declarations.length} 個)`);

  return [{ functionDeclarations: declarations }];
}

const geminiTools = convertToolsToGemini(anthropicTools);

/**
 * 動態生成系統提示（Gemini 優化：精簡版）
 */
function getSystemPrompt() {
  const today = new Date().toISOString().slice(0, 10);
  const year = new Date().getFullYear();

  return `你是 LINE 全能家庭 AI 管家。用繁體中文回覆，語氣親切，善用 emoji，回覆簡潔適合手機閱讀。
今天：${today}。日期沒年份預設 ${year} 年，已過就用 ${year + 1} 年。

重要：你只能使用工具回傳的資料，絕對不可編造任何資訊。

## 工具使用規則
- 使用者問機票/航班/比價 → 呼叫 search_all_flights（預設出發 TPE）
- 使用者問天氣/溫度/下雨 → 呼叫 get_weather
- 使用者問新聞（台灣/國際/科技/財經等）→ 呼叫 get_news
- 使用者問行程/行事曆 → 呼叫 get_events
- 使用者說早報/晨報/今日摘要/每日簡報 → 呼叫 trigger_briefing
- 使用者說加行程/新增會議 → 呼叫 add_event
- 使用者說改行程/更新 → 先 get_events 再 update_event
- 使用者說刪行程/取消 → 先 get_events 再 delete_event

## 航班回覆格式
系統自動產生 Flex 卡片，你的文字只做分析摘要。不要用 markdown 表格。格式：

✈️ 出發地 → 目的地
📅 日期 | 艙等

🏆 推薦：航空 航班號
  └ 出發→抵達 | 直飛/轉機 | 飛行時間
  └ 💰 NT$票價
  └ ✅ 推薦原因

📊 其他：
2️⃣ 航空 航班號 | 時間 | NT$票價
3️⃣ 航空 航班號 | 時間 | NT$票價

## 新聞回覆格式
不要附連結URL。格式：

📰 地區分類新聞

1️⃣ 標題
📍來源

2️⃣ 標題
📍來源

⭐ 一句焦點總結

## 航空代碼
CI=華航 BR=長榮 JX=星宇 EK=阿聯酋 TK=土航 CX=國泰 SQ=新航

## 城市代碼
台北:TPE 東京:NRT 大阪:KIX 首爾:ICN 曼谷:BKK 新加坡:SIN 香港:HKG 倫敦:LHR 紐約:JFK 洛杉磯:LAX`;
}

// 對話記錄
const conversations = new Map();
const MAX_HISTORY = 20;

/**
 * 處理使用者訊息 - 主入口
 */
async function handleMessage(userId, userMessage) {
  logger.info(`[AI] === 收到訊息 === userId=${userId.slice(-6)} msg="${userMessage}"`);

  if (!conversations.has(userId)) conversations.set(userId, []);
  const history = conversations.get(userId);
  history.push({ role: "user", content: userMessage });
  while (history.length > MAX_HISTORY) history.shift();

  try {
    const response = useGemini
      ? await runGeminiLoop(history)
      : await runAnthropicLoop(history);

    history.push({ role: "assistant", content: response.text });
    logger.info(`[AI] === 回覆完成 === 去程=${response.flights?.length || 0} 回程=${response.inboundFlights?.length || 0} textLen=${response.text?.length || 0}`);
    return response;
  } catch (error) {
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
    // 轉換歷史紀錄為 Gemini contents 格式
    const contents = history.map((msg) => ({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content }],
    }));

    // Gemini 設定：明確啟用 function calling
    const geminiConfig = {
      systemInstruction: getSystemPrompt(),
      tools: geminiTools,
      toolConfig: {
        functionCallingConfig: {
          mode: "AUTO",
        },
      },
    };

    logger.info(`[AI] Gemini API (${config.gemini.model}) contents=${contents.length} tools=${geminiTools[0].functionDeclarations.length}`);

    while (iterations-- > 0) {
      let response;
      try {
        response = await genAI.models.generateContent({
          model: config.gemini.model,
          contents,
          config: geminiConfig,
        });
      } catch (e) {
        logger.error(`[AI] Gemini API 錯誤: ${e.message}`, { stack: e.stack });
        return { text: `AI 呼叫失敗：${e.message}` };
      }

      // 檢查 function calls
      const functionCalls = response.functionCalls || [];
      logger.info(`[AI] Gemini 回應: functionCalls=${functionCalls.length} hasText=${!!response.text}`);

      if (functionCalls.length === 0) {
        const text = response.text || "抱歉，我不太理解。試試看：「台灣新聞」「台北天氣」「晨報」";
        logger.info(`[AI] 純文字回覆: "${text.slice(0, 80)}..."`);
        return { text, flights: lastFlights, inboundFlights: lastInboundFlights };
      }

      // 把 model 的回覆（含 functionCall）加入 contents
      if (response.candidates && response.candidates[0] && response.candidates[0].content) {
        contents.push(response.candidates[0].content);
      }

      // 執行所有 function calls
      const functionResponseParts = [];

      for (const fc of functionCalls) {
        logger.info(`[AI] >>> 呼叫工具: ${fc.name}`, { args: JSON.stringify(fc.args) });

        const startTime = Date.now();
        const result = await executeTool(fc.name, fc.args || {});
        const elapsed = Date.now() - startTime;

        logger.info(`[AI] <<< 工具完成: ${fc.name} (${elapsed}ms) textLen=${result.text?.length || 0}`);

        if (result.flights && result.flights.length > 0) {
          lastFlights = result.flights;
        }
        if (result.inboundFlights && result.inboundFlights.length > 0) {
          lastInboundFlights = result.inboundFlights;
        }

        functionResponseParts.push({
          functionResponse: {
            name: fc.name,
            response: { result: typeof result.text === "string" ? result.text : JSON.stringify(result.text) },
          },
        });
      }

      // 把工具結果加入 contents
      contents.push({ role: "user", parts: functionResponseParts });
    }

    return { text: "查詢太複雜了，試試：「台北飛東京 3/15-3/20」" };
  };

  return Promise.race([agentWork(), timeout]);
}

// ================================================================
// Anthropic Agent Loop (Fallback)
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
      logger.info(`[AI] 呼叫 Anthropic API... (剩餘迴圈=${iterations + 1})`);

      const res = await anthropic.messages.create({
        model: config.anthropic.model,
        max_tokens: 2000,
        system: getSystemPrompt(),
        tools: anthropicTools,
        messages,
      });

      logger.info(`[AI] Anthropic 回應: stop_reason=${res.stop_reason}`);

      if (res.stop_reason === "end_turn") {
        const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
        return { text, flights: lastFlights, inboundFlights: lastInboundFlights };
      }

      if (res.stop_reason === "tool_use") {
        messages.push({ role: "assistant", content: res.content });
        const toolResults = [];

        for (const tu of res.content.filter((b) => b.type === "tool_use")) {
          logger.info(`[AI] >>> 呼叫工具: ${tu.name}`, { input: JSON.stringify(tu.input) });

          const startTime = Date.now();
          const result = await executeTool(tu.name, tu.input);
          const elapsed = Date.now() - startTime;

          logger.info(`[AI] <<< 工具完成: ${tu.name} (${elapsed}ms)`);

          if (result.flights && result.flights.length > 0) lastFlights = result.flights;
          if (result.inboundFlights && result.inboundFlights.length > 0) lastInboundFlights = result.inboundFlights;

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

  // === 航班相關工具 ===
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

    logger.info(`[Tool] ${name}: ${params.origin}→${params.destination} ${params.departDate}`);

    switch (name) {
      case "search_all_flights": {
        try {
          const result = await searchAll(params, airlines);
          const text = formatResultsForAI(result);
          const { outbound, inbound } = extractFlightsForFlex(result);
          logger.info(`[Tool] search_all 完成: 去程=${outbound.length} 回程=${inbound.length}`);
          return { text, flights: outbound, inboundFlights: inbound };
        } catch (e) {
          logger.error(`[Tool] search_all 失敗`, { error: e.message });
          return { text: `搜尋失敗：${e.message}` };
        }
      }
      case "search_cash_only": {
        try {
          const result = await searchCashFlights(params, airlines);
          const text = formatResultsForAI(result);
          const outbound = result.flights || [];
          const inbound = result.inboundFlights || [];
          return { text, flights: outbound, inboundFlights: inbound };
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
        const text = links.map((l) => `${l.airline}: ${l.url}`).join("\n");
        return { text };
      }
    }
  }

  // === 天氣 ===
  if (name === "get_weather") {
    return await weatherService.getWeather(input.city, input.days || 1);
  }

  // === 新聞 ===
  if (name === "get_news") {
    return await newsService.getNews(input.category || "general", input.count || 7, input.region || "tw");
  }

  // === 行事曆 ===
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

  // === 每日晨報 ===
  if (name === "trigger_briefing") {
    if (!briefingService.isAvailable()) return { text: "每日晨報功能未啟用（未設定 BRIEFING_RECIPIENTS）。" };
    try {
      await briefingService.triggerBriefing();
      return { text: "已成功推送今日晨報！請查看 LINE 訊息。" };
    } catch (e) {
      return { text: `晨報推送失敗：${e.message}` };
    }
  }

  return { text: `未知工具：${name}` };
}

/**
 * 從完整比價結果提取航班資料供 Flex Message 使用
 */
function extractFlightsForFlex(result) {
  const outbound = [];
  const inbound = [];

  if (result.cash && result.cash.flights && result.cash.flights.length > 0) {
    outbound.push(...result.cash.flights);
  }
  if (result.inbound && result.inbound.length > 0) {
    inbound.push(...result.inbound);
  } else if (result.cash && result.cash.inboundFlights && result.cash.inboundFlights.length > 0) {
    inbound.push(...result.cash.inboundFlights);
  }

  return {
    outbound: outbound.slice(0, 10),
    inbound: inbound.slice(0, 10),
  };
}

function clearHistory(userId) {
  conversations.delete(userId);
}

module.exports = { handleMessage, clearHistory };
