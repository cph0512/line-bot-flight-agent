// =============================================
// Claude AI Agent（全能管家版 v3）
//
// 核心流程：
// 1. 接收使用者自然語言
// 2. Claude 理解意圖，自動選擇工具
// 3. 執行工具：航班查詢/天氣/新聞/行事曆/晨報
// 4. 分析結果，給出建議
// =============================================

const Anthropic = require("@anthropic-ai/sdk").default;
const { config } = require("../config");
const { tools } = require("./tools");
const {
  searchAll,
  searchCashFlights,
  searchMilesFlights,
  formatResultsForAI,
  getBookingLinks,
} = require("../scraper/scraperEngine");
const { weatherService, newsService, calendarService, briefingService } = require("../services");
const logger = require("../utils/logger");

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

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
用表格方式整理結果。去程和回程分開列出，格式如下：

✈️ **去程：{出發地} → {目的地}**
📅 {去程日期} | {艙等}

| 排名 | 航空 | 航班 | 出發→抵達 | 飛行時間 | 機型 | 來回票價(TWD) |
|------|------|------|----------|---------|------|-------------|
| 1 | 長榮 | BR6 | 10:20→07:00 | 11h40m | 777-300ER | 28,266 |
| 2 | 華航 | CI32 | 23:55→11:00 | 16h05m | 777-300ER | 33,782 |

🔙 **回程：{目的地} → {出發地}**
📅 {回程日期}

| 排名 | 航空 | 航班 | 出發→抵達 | 飛行時間 | 機型 |
|------|------|------|----------|---------|------|
| 1 | 長榮 | BR11 | 00:05→05:25 | 14h20m | 777-300ER |
| 2 | 華航 | CI33 | 12:00→17:30 | 13h30m | 777-300ER |

⚠️ 票價為「來回總價」（含去回程），不要寫成單程價。
💡 **推薦**：簡短推薦最佳選擇（最便宜/最快/直飛）

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
## 🌤️ 天氣查詢
- 使用 get_weather 工具查詢台灣各縣市天氣
- 支援城市簡稱：台北、新北、桃園、台中等
- days=1 查 36 小時預報，days=2~7 查一週預報
- 包含降雨機率、溫度、穿衣/帶傘建議

---
## 📰 新聞查詢
- 使用 get_news 工具取得台灣即時新聞
- 分類：general(綜合), business(財經), technology(科技), sports(體育), entertainment(娛樂), health(健康), science(科學)
- 預設 5 筆，最多 10 筆

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
- 整合天氣 + 今日行程 + 新聞一次推送`;
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
    const response = await runAgentLoop(history);
    history.push({ role: "assistant", content: response.text });
    logger.info(`[AI] === 回覆完成 === 去程=${response.flights?.length || 0} 回程=${response.inboundFlights?.length || 0} textLen=${response.text?.length || 0}`);
    return response;
  } catch (error) {
    logger.error("[AI] handleMessage 失敗", { error: error.message, stack: error.stack });
    return { text: `抱歉，系統發生錯誤：${error.message}\n請稍後再試！` };
  }
}

/**
 * AI Agent 迴圈 - Claude 可能呼叫多個工具
 */
async function runAgentLoop(history) {
  const messages = [...history];
  let iterations = 5;
  let lastFlights = null;
  let lastInboundFlights = null;

  // 整體超時保護：55 秒（LINE replyToken 有效 60 秒）
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("AI 處理超時（55 秒）")), 55000)
  );

  const agentWork = async () => {
    while (iterations-- > 0) {
      logger.info(`[AI] 呼叫 Claude API... (剩餘迴圈=${iterations + 1})`);

      const res = await anthropic.messages.create({
        model: config.anthropic.model,
        max_tokens: 2000,
        system: getSystemPrompt(),
        tools,
        messages,
      });

      logger.info(`[AI] Claude 回應: stop_reason=${res.stop_reason}, content_types=[${res.content.map((b) => b.type).join(",")}]`);

      // AI 直接回覆（沒有呼叫工具）
      if (res.stop_reason === "end_turn") {
        const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
        logger.info(`[AI] 直接回覆（未呼叫工具）textLen=${text.length}`);
        return { text, flights: lastFlights, inboundFlights: lastInboundFlights };
      }

      // AI 要求使用工具
      if (res.stop_reason === "tool_use") {
        messages.push({ role: "assistant", content: res.content });
        const toolResults = [];

        for (const tu of res.content.filter((b) => b.type === "tool_use")) {
          logger.info(`[AI] >>> 呼叫工具: ${tu.name}`, { input: JSON.stringify(tu.input) });

          const startTime = Date.now();
          const result = await executeTool(tu.name, tu.input);
          const elapsed = Date.now() - startTime;

          logger.info(`[AI] <<< 工具完成: ${tu.name} (${elapsed}ms) flightsFound=${result.flights?.length || 0}`);

          if (result.flights && result.flights.length > 0) {
            lastFlights = result.flights;
          }
          if (result.inboundFlights && result.inboundFlights.length > 0) {
            lastInboundFlights = result.inboundFlights;
          }

          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: typeof result.text === "string" ? result.text : JSON.stringify(result.text),
          });
        }

        messages.push({ role: "user", content: toolResults });
        continue;
      }

      // 其他情況
      const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n")
        || "可以再說清楚一點嗎？";
      return { text, flights: lastFlights, inboundFlights: lastInboundFlights };
    }

    return { text: "查詢太複雜了，試試：「台北飛東京 3/15-3/20」" };
  };

  return Promise.race([agentWork(), timeout]);
}

/**
 * 執行工具 - 呼叫對應的爬蟲
 */
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
          logger.info(`[Tool] search_all 完成: 去程=${outbound.length} 回程=${inbound.length} milesFlights=${result.miles?.flights?.length || 0}`);
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
          logger.info(`[Tool] search_cash 完成: 去程=${outbound.length} 回程=${inbound.length}`);
          return { text, flights: outbound, inboundFlights: inbound };
        } catch (e) {
          logger.error(`[Tool] search_cash 失敗`, { error: e.message, stack: e.stack });
          return { text: `現金票搜尋失敗：${e.message}` };
        }
      }
      case "search_miles_only": {
        try {
          const result = await searchMilesFlights(params, airlines);
          const text = formatResultsForAI(result);
          logger.info(`[Tool] search_miles 完成: flights=${result.flights?.length || 0}`);
          return { text, flights: [] };
        } catch (e) {
          logger.error(`[Tool] search_miles 失敗`, { error: e.message, stack: e.stack });
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
    if (!weatherService.isAvailable()) {
      return { text: "天氣查詢功能未啟用（未設定 CWA_API_KEY）。" };
    }
    return await weatherService.getWeather(input.city, input.days || 1);
  }

  // === 新聞 ===
  if (name === "get_news") {
    if (!newsService.isAvailable()) {
      return { text: "新聞查詢功能未啟用（未設定 NEWS_API_KEY）。" };
    }
    return await newsService.getNews(input.category || "general", input.count || 5);
  }

  // === 行事曆：查詢 ===
  if (name === "get_events") {
    if (!calendarService.isAvailable()) {
      return { text: "行事曆功能未啟用（未設定 Google Calendar）。" };
    }
    return await calendarService.getEvents(input.calendarName, input.startDate, input.endDate);
  }

  // === 行事曆：新增 ===
  if (name === "add_event") {
    if (!calendarService.isAvailable()) {
      return { text: "行事曆功能未啟用（未設定 Google Calendar）。" };
    }
    return await calendarService.addEvent(
      input.calendarName, input.summary, input.startTime, input.endTime, input.description
    );
  }

  // === 行事曆：更新 ===
  if (name === "update_event") {
    if (!calendarService.isAvailable()) {
      return { text: "行事曆功能未啟用（未設定 Google Calendar）。" };
    }
    const updates = {};
    if (input.summary) updates.summary = input.summary;
    if (input.startTime) updates.startTime = input.startTime;
    if (input.endTime) updates.endTime = input.endTime;
    if (input.description) updates.description = input.description;
    return await calendarService.updateEvent(input.eventId, input.calendarName, updates);
  }

  // === 行事曆：刪除 ===
  if (name === "delete_event") {
    if (!calendarService.isAvailable()) {
      return { text: "行事曆功能未啟用（未設定 Google Calendar）。" };
    }
    return await calendarService.deleteEvent(input.eventId, input.calendarName);
  }

  // === 每日晨報 ===
  if (name === "trigger_briefing") {
    if (!briefingService.isAvailable()) {
      return { text: "每日晨報功能未啟用（未設定 BRIEFING_RECIPIENTS）。" };
    }
    try {
      await briefingService.triggerBriefing();
      return { text: "已成功推送今日晨報！請查看 LINE 訊息。" };
    } catch (e) {
      logger.error(`[Tool] trigger_briefing 失敗`, { error: e.message });
      return { text: `晨報推送失敗：${e.message}` };
    }
  }

  return { text: `未知工具：${name}` };
}

/**
 * 從完整比價結果提取航班資料供 Flex Message 使用
 * 回傳 { outbound, inbound } 兩個陣列
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
