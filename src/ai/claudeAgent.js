// =============================================
// Claude AI Agent（RPA 版）
//
// 核心大腦：
// 1. 接收使用者自然語言
// 2. Claude 理解意圖
// 3. 自動呼叫 RPA 爬蟲查詢航班
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
const logger = require("../utils/logger");

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

const SYSTEM_PROMPT = `你是一個專業又親切的機票查詢助手，在 LINE 上幫助台灣使用者查詢和比較機票。

## 你的特殊能力
你可以直接到各航空公司官網（華航、長榮、星宇、阿聯酋、土航、國泰、新航）查詢：
- 💰 現金票價
- 🎯 里程兌換票價
- 📊 並比較哪種方式最划算

## 行為規則
1. 用繁體中文回覆，語氣親切，善用 emoji
2. 從對話提取：出發地（預設桃園TPE）、目的地、日期、人數
3. 資訊不足時友善詢問（一次問一個問題就好）
4. 搜尋需要時間（爬官網比 API 慢），先告知使用者「正在查詢中」
5. 結果出來後整理重點：
   - 💰 最便宜現金票
   - ✈️ 直飛選項
   - 🎯 里程兌換是否划算（與現金票比較）
   - ⭐ 你推薦的最佳選項
6. 給建議時考慮：價格、里程價值、飛行時間、轉機次數、航空公司服務品質
7. 回覆簡潔，適合手機閱讀
8. 無法直接訂票，找到航班後提供官網連結

## 嚴格禁止
- 絕對不可以自己編造、估算、猜測機票價格或航班時刻
- 只能使用工具回傳的真實資料
- 如果工具查詢失敗或回傳空結果，直接告訴使用者「查詢失敗」並附上官網連結讓他們自己查
- 不要說「預估」、「大約」、「一般來說」這類模糊用語來包裝虛構的價格

## 里程價值判斷基準
- 每哩價值超過 NT$0.4 = 划算
- 每哩價值超過 NT$0.6 = 非常划算
- 每哩價值低於 NT$0.3 = 不划算，建議用現金買

## 航空公司資訊
- 華航(CI)：天合聯盟，華夏會員，Dynasty Flyer 里程
- 長榮(BR)：星空聯盟，無限萬哩遊，Infinity MileageLands
- 星宇(JX)：無聯盟，COSMILE 里程計畫
- 阿聯酋(EK)：無聯盟，Skywards 里程計畫
- 土耳其航空(TK)：星空聯盟，Miles&Smiles 里程計畫
- 國泰(CX)：寰宇一家，Asia Miles 亞洲萬里通
- 新加坡航空(SQ)：星空聯盟，KrisFlyer 里程計畫

## 城市代碼
台北:TPE 高雄:KHH 東京(成田):NRT 東京(羽田):HND 大阪:KIX
名古屋:NGO 福岡:FUK 札幌:CTS 沖繩:OKA
首爾:ICN 釜山:PUS 曼谷:BKK 新加坡:SIN
香港:HKG 上海:PVG 倫敦:LHR 巴黎:CDG 紐約:JFK 洛杉磯:LAX
杜拜:DXB 伊斯坦堡:IST 吉隆坡:KUL 雪梨:SYD 墨爾本:MEL`;

// 對話記錄
const conversations = new Map();
const MAX_HISTORY = 20;

/**
 * 處理使用者訊息
 */
async function handleMessage(userId, userMessage) {
  logger.info("收到訊息", { userId: userId.slice(-6), message: userMessage });

  if (!conversations.has(userId)) conversations.set(userId, []);
  const history = conversations.get(userId);
  history.push({ role: "user", content: userMessage });
  while (history.length > MAX_HISTORY) history.shift();

  try {
    const response = await runAgentLoop(history);
    history.push({ role: "assistant", content: response.text });
    return response; // { text, flights? }
  } catch (error) {
    logger.error("AI 處理失敗", { error: error.message });
    return { text: "抱歉，我遇到問題了 😅 請稍後再試！" };
  }
}

/**
 * AI Agent 迴圈 - Claude 可能呼叫多個工具
 * @returns {{ text: string, flights?: Array }} AI 回覆文字 + 可選的航班資料
 */
async function runAgentLoop(history) {
  const messages = [...history];
  let iterations = 5;
  let lastFlights = null; // 保留最後一次工具回傳的航班資料

  while (iterations-- > 0) {
    const res = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    // AI 直接回覆
    if (res.stop_reason === "end_turn") {
      const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      return { text, flights: lastFlights };
    }

    // AI 要求使用工具
    if (res.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: res.content });
      const toolResults = [];

      for (const tu of res.content.filter((b) => b.type === "tool_use")) {
        logger.info(`🔧 呼叫工具: ${tu.name}`, { input: tu.input });

        const result = await executeTool(tu.name, tu.input);

        // 保留航班資料供 Flex Message 使用
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

  return { text: "查詢太複雜了 😅 試試：「台北飛東京 3/15-3/20」" };
}

/**
 * 執行工具
 * @returns {{ text: string, flights?: Array }} 工具結果文字 + 可選的航班陣列
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

  switch (name) {
    case "search_all_flights": {
      try {
        const result = await searchAll(params, airlines);
        const text = formatResultsForAI(result);
        // 合併現金票和里程票的航班資料，以現金票為優先（用於 Flex Message）
        const flights = extractFlightsForFlex(result);
        return { text, flights };
      } catch (e) {
        return { text: `完整比價搜尋失敗：${e.message}` };
      }
    }

    case "search_cash_only": {
      try {
        const result = await searchCashFlights(params, airlines);
        const text = formatResultsForAI(result);
        const flights = result.flights || [];
        return { text, flights };
      } catch (e) {
        return { text: `現金票搜尋失敗：${e.message}` };
      }
    }

    case "search_miles_only": {
      try {
        const result = await searchMilesFlights(params, airlines);
        const text = formatResultsForAI(result);
        return { text, flights: [] }; // 里程票不適合 Flex 比價（無現金價格）
      } catch (e) {
        return { text: `里程票搜尋失敗：${e.message}` };
      }
    }

    case "get_booking_links": {
      const links = getBookingLinks(params);
      const text = links.map((l) => `🔗 ${l.airline}:\n${l.url}`).join("\n\n");
      return { text };
    }

    default:
      return { text: `未知工具：${name}` };
  }
}

/**
 * 從完整比價結果提取航班資料供 Flex Message 使用
 * 優先使用現金票（有明確價格），最多取 10 筆
 */
function extractFlightsForFlex(result) {
  const flights = [];

  // 優先使用現金票
  if (result.cash && result.cash.flights && result.cash.flights.length > 0) {
    flights.push(...result.cash.flights);
  }

  // 如果現金票為空，但有里程票則不加入（里程票缺少現金價格，不適合比價卡片）

  return flights.slice(0, 10);
}

function clearHistory(userId) {
  conversations.delete(userId);
}

module.exports = { handleMessage, clearHistory };
