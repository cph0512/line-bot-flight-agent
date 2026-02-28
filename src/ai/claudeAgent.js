// =============================================
// Claude AI Agent（Amadeus + RPA 版）
//
// 核心流程：
// 1. 接收使用者自然語言
// 2. Claude 理解意圖 + 自動補上當前年份
// 3. Claude 呼叫工具 → Amadeus API 查詢航班
// 4. 分析真實結果，給出比較建議
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
const logger = require("../utils/logger");

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

/**
 * 動態生成系統提示（包含當天日期）
 */
function getSystemPrompt() {
  const today = new Date().toISOString().slice(0, 10);
  const year = new Date().getFullYear();

  return `你是一個 LINE 機票查詢助手。你必須透過工具查詢即時航班資料。

## 今天的日期：${today}
使用者提到的日期如果沒有指定年份，預設使用 ${year} 年。
例如：「3/26」→「${year}-03-26」，「4/2」→「${year}-04-02」。
如果該日期已過去，則用 ${year + 1} 年。

## 最重要的規則（絕對不可違反）
1. 收到航班查詢請求時，你「必須立刻」呼叫 search_all_flights 或 search_cash_only 工具。
2. 「絕對不可以」跳過搜尋直接呼叫 get_booking_links。get_booking_links 只能在搜尋失敗後才使用。
3. 你「只能」使用工具回傳的真實資料。不可以自己編造、預估、猜測任何航班資訊。
4. 絕對禁止輸出：自行編造的價格、預估價格、機型、飛行時間、航班號碼。

## 工具使用順序（嚴格遵守）
步驟 1：收到航班查詢 → 立刻呼叫 search_all_flights（帶入正確的年份！）
步驟 2：收到結果 → 整理成表格格式回覆
步驟 3：只有在步驟 1 完全失敗時 → 才呼叫 get_booking_links

## 回覆格式（收到航班資料後）
用表格方式整理結果，格式如下：

✈️ **{出發地} → {目的地} 航班比價**
📅 {日期} | {艙等}

| 排名 | 航空 | 航班 | 出發→抵達 | 飛行時間 | 機型 | 票價(TWD) |
|------|------|------|----------|---------|------|----------|
| 1 | 長榮 | BR6 | 10:20→07:00 | 13h40m | 777-300ER | 41,847 |
| 2 | 華航 | CI32 | 23:55→11:00 | 16h05m | 777-300ER | 47,782 |

💡 **推薦**：簡短推薦最佳選擇（最便宜/最快/直飛）

## 一般回覆規則
- 用繁體中文，語氣親切，善用 emoji
- 從對話提取：出發地（預設 TPE）、目的地、日期、人數、艙等
- 資訊不足時友善詢問（至少需要目的地和日期）
- 回覆簡潔，適合手機閱讀

## 查詢失敗時的回覆
「抱歉，查詢失敗。以下是各航空公司訂票連結：」然後呼叫 get_booking_links。
不可以額外補充任何你自己知道的航班資訊。

## 里程價值判斷
- 每哩 > NT$0.4 = 划算
- 每哩 > NT$0.6 = 非常划算
- 每哩 < NT$0.3 = 不划算

## 航空公司代碼
CI=華航, BR=長榮, JX=星宇, EK=阿聯酋, TK=土航, CX=國泰, SQ=新航

## 城市代碼
台北:TPE 高雄:KHH 東京(成田):NRT 東京(羽田):HND 大阪:KIX
名古屋:NGO 福岡:FUK 札幌:CTS 沖繩:OKA
首爾:ICN 釜山:PUS 曼谷:BKK 新加坡:SIN
香港:HKG 上海:PVG 倫敦:LHR 巴黎:CDG
紐約:JFK 洛杉磯:LAX 杜拜:DXB 伊斯坦堡:IST
吉隆坡:KUL 雪梨:SYD 墨爾本:MEL`;
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
    logger.info(`[AI] === 回覆完成 === flights=${response.flights?.length || 0} textLen=${response.text?.length || 0}`);
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

  // 整體超時保護：50 秒
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("AI 處理超時（50 秒）")), 50000)
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
        return { text, flights: lastFlights };
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
      return { text, flights: lastFlights };
    }

    return { text: "查詢太複雜了，試試：「台北飛東京 3/15-3/20」" };
  };

  return Promise.race([agentWork(), timeout]);
}

/**
 * 執行工具 - 呼叫對應的爬蟲
 */
async function executeTool(name, input) {
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
        const flights = extractFlightsForFlex(result);
        logger.info(`[Tool] search_all 完成: cashFlights=${result.cash?.flights?.length || 0} milesFlights=${result.miles?.flights?.length || 0}`);
        return { text, flights };
      } catch (e) {
        logger.error(`[Tool] search_all 失敗`, { error: e.message, stack: e.stack });
        return { text: `搜尋失敗：${e.message}` };
      }
    }

    case "search_cash_only": {
      try {
        const result = await searchCashFlights(params, airlines);
        const text = formatResultsForAI(result);
        const flights = result.flights || [];
        logger.info(`[Tool] search_cash 完成: flights=${flights.length}`);
        return { text, flights };
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

    default:
      return { text: `未知工具：${name}` };
  }
}

/**
 * 從完整比價結果提取航班資料供 Flex Message 使用
 */
function extractFlightsForFlex(result) {
  const flights = [];
  if (result.cash && result.cash.flights && result.cash.flights.length > 0) {
    flights.push(...result.cash.flights);
  }
  return flights.slice(0, 10);
}

function clearHistory(userId) {
  conversations.delete(userId);
}

module.exports = { handleMessage, clearHistory };
