// =============================================
// AI Agent（全能管家版 v4 — Gemini 版）
//
// 核心流程：
// 1. 接收使用者自然語言
// 2. Gemini 理解意圖，自動選擇工具
// 3. 執行工具：航班查詢/天氣/新聞/行事曆/晨報
// 4. 分析結果，給出建議
//
// 支援 Gemini（預設）或 Anthropic（fallback）
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
} else {
  const Anthropic = require("@anthropic-ai/sdk").default;
  anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });
}

// ========== 工具定義轉換（Anthropic → Gemini）==========
function convertToolsToGemini(tools) {
  return [{
    functionDeclarations: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: convertSchema(t.input_schema),
    })),
  }];
}

function convertSchema(schema) {
  if (!schema) return undefined;
  const result = {};

  // 型別轉大寫（Gemini 格式）
  if (schema.type) result.type = schema.type.toUpperCase();
  if (schema.description) result.description = schema.description;
  if (schema.enum) result.enum = schema.enum;
  if (schema.required) result.required = schema.required;

  // 遞迴轉換 properties
  if (schema.properties) {
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

const geminiTools = convertToolsToGemini(anthropicTools);

/**
 * 動態生成系統提示（包含當天日期）
 */
function getSystemPrompt() {
  const today = new Date().toISOString().slice(0, 10);
  const year = new Date().getFullYear();

  return `你是一個 LINE 全能家庭 AI 管家。你可以處理航班查詢、天氣預報、新聞、行事曆管理和每日晨報。

## 今天的日期：${today}
使用者提到的日期如果沒有指定年份，預設使用 ${year} 年。
例如：「3/26」→「${year}-03-26」，「4/2」→「${year}-04-02」。
如果該日期已過去，則用 ${year + 1} 年。

## 一般回覆規則
- 用繁體中文，語氣親切，善用 emoji
- 回覆簡潔，適合手機閱讀
- 你「只能」使用工具回傳的真實資料。不可以自己編造任何資訊。

---
## ✈️ 機票查詢

### 最重要的規則（絕對不可違反）
1. 收到航班查詢請求時，你「必須立刻」呼叫 search_all_flights 或 search_cash_only 工具。
2. 「絕對不可以」跳過搜尋直接呼叫 get_booking_links。get_booking_links 只能在搜尋失敗後才使用。
3. 絕對禁止輸出：自行編造的價格、預估價格、機型、飛行時間、航班號碼。

### 工具使用順序
步驟 1：收到航班查詢 → 立刻呼叫 search_all_flights（帶入正確的年份！）
步驟 2：收到結果 → 整理成表格格式回覆
步驟 3：只有在步驟 1 完全失敗時 → 才呼叫 get_booking_links

### 回覆格式（收到航班資料後）
系統會自動產生漂亮的 Flex 卡片顯示航班表格，你的文字訊息只需要做「分析摘要」，不要重複列表格。
絕對不要用 markdown 表格（| --- | 格式），LINE 不支援 markdown。

格式如下：

✈️ {出發地} → {目的地}
📅 {去程日期}～{回程日期} | {艙等}

🏆 推薦：{航空} {航班號}
  └ {出發時間}→{抵達時間} | {直飛/轉N次} | {飛行時間}
  └ 💰 NT$來回票價 來回
  └ ✅ {推薦原因：最便宜/最快/直飛等}

📊 其他選項：
2️⃣ {航空} {航班號} | {時間} | NT$票價
3️⃣ {航空} {航班號} | {時間} | NT$票價

⚠️ 以上為來回總價（含去回程）

規則：
- 不要用 markdown 表格，用簡潔的條列式
- 推薦最佳選擇放最上面，用 🏆 標記
- 其他選項簡短一行帶過即可
- 票價為「來回總價」，不要寫成單程價

- 從對話提取：出發地（預設 TPE）、目的地、日期、人數、艙等
- 資訊不足時友善詢問（至少需要目的地和日期）

### 查詢失敗時
「抱歉，查詢失敗。以下是各航空公司訂票連結：」然後呼叫 get_booking_links。
不可以額外補充任何你自己知道的航班資訊。

### 里程價值判斷
- 每哩 > NT$0.4 = 划算
- 每哩 > NT$0.6 = 非常划算
- 每哩 < NT$0.3 = 不划算

### 航空公司代碼
CI=華航, BR=長榮, JX=星宇, EK=阿聯酋, TK=土航, CX=國泰, SQ=新航

### 城市代碼
台北:TPE 高雄:KHH 東京(成田):NRT 東京(羽田):HND 大阪:KIX
名古屋:NGO 福岡:FUK 札幌:CTS 沖繩:OKA
首爾:ICN 釜山:PUS 曼谷:BKK 新加坡:SIN
香港:HKG 上海:PVG 倫敦:LHR 巴黎:CDG
紐約:JFK 洛杉磯:LAX 杜拜:DXB 伊斯坦堡:IST
吉隆坡:KUL 雪梨:SYD 墨爾本:MEL

---
## 🌤️ 天氣查詢（全球）
- 使用 get_weather 工具查詢全球天氣
- 台灣城市（台北、新北等）→ CWA 氣象署（更精確）
- 國際城市（Tokyo、London 等）→ Open-Meteo（免費全球覆蓋）
- days=1 查今天，days=2~7 查多天預報
- 包含降雨機率、溫度、穿衣/帶傘建議
- 支援中英文城市名

---
## 📰 新聞查詢（台灣+國際）
- 使用 get_news 工具取得即時新聞
- region="tw"（預設）台灣新聞，region="world" 國際新聞
- 使用者說「國際新聞」「世界新聞」→ region="world"
- 分類：general(綜合), business(財經), technology(科技), sports(體育), entertainment(娛樂), health(健康), science(科學)
- 預設 7 筆，最多 10 筆

### 新聞回覆格式（嚴格遵守）
收到新聞資料後，用以下格式回覆，不可自行重新分類或分組：

📰 **{地區}{分類}新聞** ({日期})

1️⃣ {新聞標題}
📍{來源} | 🔗 {實際URL網址}

2️⃣ {新聞標題}
📍{來源} | 🔗 {實際URL網址}

3️⃣ ...（依序列出全部新聞）

規則：
- 每則新聞用數字 emoji（1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣）編號
- 「不可」自行歸納分類（例如不要分成「職棒相關」「經典賽相關」等子類別）
- 「不可」用 bullet point（•）列表
- 每則標題獨立一行，來源和連結在下一行
- 🔗 後面「必須」放工具回傳的真實 URL 網址（例如 https://www.cna.com.tw/...），「不可」只寫「連結」兩個字
- 如果工具沒有回傳連結，則省略 🔗 那段
- 最後一行可加一句簡短的今日焦點總結

---
## 📅 行事曆管理
- get_events：查詢行程（可指定日期範圍，空=今天）
- add_event：新增行程（自動偵測時間衝突）
- update_event：更新行程（需先用 get_events 取得 eventId）
- delete_event：刪除行程（需先用 get_events 取得 eventId）
- calendarName 空白=個人行事曆，「全家」=全部家人行事曆
- 全天事件用 YYYY-MM-DD 格式，有時間的用 YYYY-MM-DDTHH:mm:ss

---
## ☀️ 每日晨報
- 使用者說「早報」「今日摘要」「每日簡報」→ 呼叫 trigger_briefing
- 整合多城市天氣 + 今日行程 + 多區域新聞一次推送
- 系統已設定每日自動定時推送（透過 MORNING_BRIEFING_TIME 排程）
- 支援多城市天氣（透過 BRIEFING_CITIES 設定）
- 支援多區域/分類新聞（透過 BRIEFING_NEWS 設定）
- 使用者問「可以自動早報嗎？」→ 回答：已有自動排程功能，需在 Railway 環境變數設定 BRIEFING_RECIPIENTS（LINE userId）和 MORNING_BRIEFING_TIME`;
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
    // 轉換歷史紀錄為 Gemini 格式
    const geminiHistory = history.slice(0, -1).map((msg) => ({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content }],
    }));

    const lastMessage = history[history.length - 1].content;

    logger.info(`[AI] 呼叫 Gemini API (${config.gemini.model})... history=${geminiHistory.length}`);

    const chat = genAI.chats.create({
      model: config.gemini.model,
      history: geminiHistory,
      config: {
        systemInstruction: getSystemPrompt(),
        tools: geminiTools,
      },
    });

    let response = await chat.sendMessage({ message: lastMessage });

    while (iterations-- > 0) {
      // 檢查是否有 function call
      const functionCalls = response.functionCalls || [];

      if (functionCalls.length === 0) {
        // 純文字回覆
        const text = response.text || "可以再說清楚一點嗎？";
        logger.info(`[AI] Gemini 純文字回覆 textLen=${text.length}`);
        return { text, flights: lastFlights, inboundFlights: lastInboundFlights };
      }

      // 執行所有 function calls
      const functionResponses = [];

      for (const fc of functionCalls) {
        logger.info(`[AI] >>> 呼叫工具: ${fc.name}`, { input: JSON.stringify(fc.args) });

        const startTime = Date.now();
        const result = await executeTool(fc.name, fc.args);
        const elapsed = Date.now() - startTime;

        logger.info(`[AI] <<< 工具完成: ${fc.name} (${elapsed}ms) flightsFound=${result.flights?.length || 0}`);

        if (result.flights && result.flights.length > 0) {
          lastFlights = result.flights;
        }
        if (result.inboundFlights && result.inboundFlights.length > 0) {
          lastInboundFlights = result.inboundFlights;
        }

        functionResponses.push({
          name: fc.name,
          response: { result: typeof result.text === "string" ? result.text : JSON.stringify(result.text) },
        });
      }

      // 把工具結果送回 Gemini
      response = await chat.sendMessage({ message: functionResponses.map((fr) => ({ functionResponse: fr })) });
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
// 執行工具（共用，不分 AI 引擎）
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

    logger.info(`[Tool] ${name}: ${params.origin}→${params.destination} ${params.departDate} cabin=${params.cabinClass || "ALL"} airlines=[${airlines.join(",")}]`);

    switch (name) {
      case "search_all_flights": {
        try {
          const result = await searchAll(params, airlines);
          const text = formatResultsForAI(result);
          const { outbound, inbound } = extractFlightsForFlex(result);
          logger.info(`[Tool] search_all 完成: 去程=${outbound.length} 回程=${inbound.length}`);
          return { text, flights: outbound, inboundFlights: inbound };
        } catch (e) {
          logger.error(`[Tool] search_all 失敗`, { error: e.message, stack: e.stack });
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
