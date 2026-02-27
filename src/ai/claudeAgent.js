// =============================================
// Claude AI Agent（RPA 版）
//
// 核心流程：
// 1. 接收使用者自然語言
// 2. Claude 理解意圖
// 3. Claude 呼叫工具 → RPA 爬蟲查詢航班
// 4. 分析真實結果，給出建議
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

const SYSTEM_PROMPT = `你是一個 LINE 機票查詢助手。你必須透過工具查詢航空公司官網取得真實資料。

## 最重要的規則（絕對不可違反）
1. 你「一定」要使用 search_all_flights 或 search_cash_only 工具去查詢。不可以自己回答航班問題。
2. 你「只能」使用工具回傳的資料。不可以自己編造、預估、猜測任何航班資訊。
3. 如果工具回傳錯誤或空結果，你只能說「查詢失敗，請直接到航空公司官網查詢」，然後用 get_booking_links 工具提供官網連結。
4. 絕對禁止輸出以下內容：自行編造的價格、預估價格範圍、機型資訊、飛行時間、航班號碼。這些全部必須來自工具查詢結果。
5. 絕對禁止使用「預估」、「大約」、「一般來說」、「通常」、「約」等模糊詞彙來包裝你自己的猜測。

## 回覆規則
- 用繁體中文，語氣親切，善用 emoji
- 從對話提取：出發地（預設 TPE）、目的地、日期、人數
- 資訊不足時友善詢問
- 收到使用者查詢航班的請求時，立刻呼叫 search_all_flights 或 search_cash_only 工具
- 查詢結果出來後只整理工具回傳的真實資料：最便宜現金票、直飛選項、里程分析、推薦
- 回覆簡潔，適合手機閱讀

## 查詢失敗時的唯一回覆格式
如果所有航空公司都查詢失敗：
「抱歉，目前無法從航空公司官網取得 [出發地] 到 [目的地] 的航班資料。請直接到以下官網查詢：[呼叫 get_booking_links 取得連結]」
不可以額外補充任何你自己知道的航班、機型、飛行時間、直飛/轉機資訊。

## 里程價值判斷
- 每哩 > NT$0.4 = 划算
- 每哩 > NT$0.6 = 非常划算
- 每哩 < NT$0.3 = 不划算

## 航空公司
CI=華航, BR=長榮, JX=星宇, EK=阿聯酋, TK=土航, CX=國泰, SQ=新航

## 城市代碼
台北:TPE 高雄:KHH 東京(成田):NRT 東京(羽田):HND 大阪:KIX
名古屋:NGO 福岡:FUK 札幌:CTS 沖繩:OKA
首爾:ICN 釜山:PUS 曼谷:BKK 新加坡:SIN
香港:HKG 上海:PVG 倫敦:LHR 巴黎:CDG
紐約:JFK 洛杉磯:LAX 杜拜:DXB 伊斯坦堡:IST
吉隆坡:KUL 雪梨:SYD 墨爾本:MEL`;

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
 * 加入 60 秒超時保護（LINE replyToken 有效時間有限）
 */
async function runAgentLoop(history) {
  const messages = [...history];
  let iterations = 5;
  let lastFlights = null;

  // 整體超時保護：60 秒
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("AI 處理超時（60 秒）")), 60000)
  );

  const agentWork = async () => {
    while (iterations-- > 0) {
      logger.info(`[AI] 呼叫 Claude API... (剩餘迴圈=${iterations + 1})`);

      const res = await anthropic.messages.create({
        model: config.anthropic.model,
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
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
  };
  const airlines = input.airlines || [];

  logger.info(`[Tool] ${name}: ${params.origin}→${params.destination} ${params.departDate} airlines=[${airlines.join(",")}]`);

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
        return { text: `完整比價搜尋失敗：${e.message}\n\n所有航空公司爬蟲都失敗了。原因可能是：瀏覽器啟動失敗、航空公司網站改版、或網路問題。` };
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
