// =============================================
// AI 工具定義（全能管家版 v3）
// Claude 可以使用的工具，包含：
// - 航班查詢與比價（4 個）
// - 天氣查詢（1 個）
// - 新聞查詢（1 個）
// - 行事曆管理（4 個）
// - 每日晨報（1 個）
// =============================================

const tools = [
  {
    name: "search_all_flights",
    description: `完整比價搜尋：同時查詢多家航空公司的現金票和里程兌換票。
這是最常用的工具，當使用者想查機票、找航班、比價時使用。
會同時查詢華航、長榮、星宇、阿聯酋、土航、國泰、新航的官網，並比較現金買票和里程兌換哪個更划算。
從對話中提取出發地、目的地、日期。中文城市名轉 IATA 代碼（台北→TPE、東京→NRT）。
沒有明確日期時先詢問使用者。預設從桃園(TPE)出發。`,
    input_schema: {
      type: "object",
      properties: {
        origin: { type: "string", description: "出發機場 IATA 代碼，例如 TPE" },
        destination: { type: "string", description: "目的地機場 IATA 代碼，例如 NRT" },
        departDate: { type: "string", description: "出發日期 YYYY-MM-DD" },
        returnDate: { type: "string", description: "回程日期 YYYY-MM-DD（單程不填）" },
        adults: { type: "number", description: "成人人數，預設 1", default: 1 },
        airlines: {
          type: "array",
          items: { type: "string", enum: ["CI", "BR", "JX", "EK", "TK", "CX", "SQ"] },
          description: "指定航空公司代碼。空陣列=查全部。CI=華航, BR=長榮, JX=星宇, EK=阿聯酋, TK=土航, CX=國泰, SQ=新航",
        },
        cabinClass: {
          type: "string",
          enum: ["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"],
          description: "艙等篩選。ECONOMY=經濟艙, PREMIUM_ECONOMY=豪華經濟艙, BUSINESS=商務艙, FIRST=頭等艙。不指定則查全部艙等。",
        },
      },
      required: ["origin", "destination", "departDate"],
    },
  },
  {
    name: "search_cash_only",
    description: `只查現金票價。當使用者明確只想看現金票、不需要里程比較時使用。比完整搜尋快。`,
    input_schema: {
      type: "object",
      properties: {
        origin: { type: "string", description: "出發機場 IATA 代碼" },
        destination: { type: "string", description: "目的地機場 IATA 代碼" },
        departDate: { type: "string", description: "出發日期 YYYY-MM-DD" },
        returnDate: { type: "string", description: "回程日期 YYYY-MM-DD" },
        adults: { type: "number", default: 1 },
        airlines: {
          type: "array",
          items: { type: "string", enum: ["CI", "BR", "JX", "EK", "TK", "CX", "SQ"] },
          description: "指定航空公司。空陣列=查全部。",
        },
        cabinClass: {
          type: "string",
          enum: ["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"],
          description: "艙等篩選。",
        },
      },
      required: ["origin", "destination", "departDate"],
    },
  },
  {
    name: "search_miles_only",
    description: `只查里程兌換票。當使用者明確想用里程換機票時使用。需要會員帳號才能查詢。`,
    input_schema: {
      type: "object",
      properties: {
        origin: { type: "string" },
        destination: { type: "string" },
        departDate: { type: "string" },
        returnDate: { type: "string" },
        adults: { type: "number", default: 1 },
        airlines: {
          type: "array",
          items: { type: "string", enum: ["CI", "BR", "JX", "EK", "TK", "CX", "SQ"] },
        },
      },
      required: ["origin", "destination", "departDate"],
    },
  },
  {
    name: "get_booking_links",
    description: `產生各航空公司官網和比價網站的訂票連結。使用者選好航班想訂票時使用。`,
    input_schema: {
      type: "object",
      properties: {
        origin: { type: "string" },
        destination: { type: "string" },
        departDate: { type: "string" },
        returnDate: { type: "string" },
        adults: { type: "number", default: 1 },
      },
      required: ["origin", "destination", "departDate"],
    },
  },
  // =============================================
  // 天氣
  // =============================================
  {
    name: "get_weather",
    description: `查詢全球天氣預報。台灣用 CWA 氣象署（更精確），國際用 Open-Meteo。
使用者問天氣、溫度、會不會下雨時使用。自動提供穿衣建議和帶傘提醒。
台灣城市：台北、新北、桃園、台中、台南、高雄等。
國際城市：Tokyo、London、New York、Paris、Bangkok 等（中英文皆可）。`,
    input_schema: {
      type: "object",
      properties: {
        city: { type: "string", description: "城市名稱（中文或英文），例如：台北、東京、Tokyo、London、New York" },
        days: { type: "number", description: "預報天數（1-7），預設 1", default: 1 },
      },
      required: ["city"],
    },
  },

  // =============================================
  // 新聞
  // =============================================
  {
    name: "get_news",
    description: `查詢台灣或國際即時新聞。支援分類：general(綜合)、business(財經)、technology(科技)、sports(體育)、entertainment(娛樂)、health(健康)、science(科學)。
使用者問最新新聞、今天新聞時使用。
使用者說「國際新聞」「世界新聞」「world news」→ region="world"。
使用者說「台灣新聞」或沒指定 → region="tw"（預設）。`,
    input_schema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["general", "business", "technology", "sports", "entertainment", "health", "science"],
          description: "新聞分類，預設 general",
        },
        count: { type: "number", description: "新聞筆數（1-10），預設 7", default: 7 },
        region: {
          type: "string",
          enum: ["tw", "world"],
          description: "地區：tw=台灣（預設），world=國際",
        },
      },
    },
  },

  // =============================================
  // 行事曆
  // =============================================
  {
    name: "get_events",
    description: `查詢 Google 行事曆事件。可查個人或家庭成員行事曆。
使用者問今天行程、這週有什麼事、明天行事曆時使用。
回傳結果包含 eventId，可用於 update_event / delete_event。`,
    input_schema: {
      type: "object",
      properties: {
        calendarName: { type: "string", description: "行事曆名稱（空=個人、「全家」=全部家人）" },
        startDate: { type: "string", description: "開始日期 YYYY-MM-DD，預設今天" },
        endDate: { type: "string", description: "結束日期 YYYY-MM-DD，預設同 startDate" },
      },
    },
  },
  {
    name: "add_event",
    description: `新增 Google 行事曆事件。會自動偵測時間衝突。
使用者說「幫我加一個會議」「新增行程」時使用。
全天事件用 YYYY-MM-DD 格式，有時間的事件用 YYYY-MM-DDTHH:mm:ss。`,
    input_schema: {
      type: "object",
      properties: {
        calendarName: { type: "string", description: "行事曆名稱（空=個人行事曆）" },
        summary: { type: "string", description: "事件標題" },
        startTime: { type: "string", description: "開始時間 YYYY-MM-DDTHH:mm:ss 或 YYYY-MM-DD" },
        endTime: { type: "string", description: "結束時間 YYYY-MM-DDTHH:mm:ss 或 YYYY-MM-DD" },
        description: { type: "string", description: "事件說明（選填）" },
      },
      required: ["summary", "startTime", "endTime"],
    },
  },
  {
    name: "update_event",
    description: `更新 Google 行事曆事件。需要 eventId（從 get_events 取得）。
使用者說「改時間」「更新會議」時，先用 get_events 查到 eventId 再更新。`,
    input_schema: {
      type: "object",
      properties: {
        eventId: { type: "string", description: "事件 ID（從 get_events 結果取得）" },
        calendarName: { type: "string", description: "行事曆名稱" },
        summary: { type: "string", description: "新標題（選填）" },
        startTime: { type: "string", description: "新開始時間（選填）" },
        endTime: { type: "string", description: "新結束時間（選填）" },
        description: { type: "string", description: "新說明（選填）" },
      },
      required: ["eventId"],
    },
  },
  {
    name: "delete_event",
    description: `刪除 Google 行事曆事件。需要 eventId（從 get_events 取得）。
使用者說「取消會議」「刪除行程」時，先用 get_events 查到 eventId 再刪。`,
    input_schema: {
      type: "object",
      properties: {
        eventId: { type: "string", description: "事件 ID" },
        calendarName: { type: "string", description: "行事曆名稱" },
      },
      required: ["eventId"],
    },
  },

  // =============================================
  // 每日晨報
  // =============================================
  {
    name: "trigger_briefing",
    description: `手動觸發每日早報。整合天氣、今日行程、新聞摘要一次推送。
使用者說「早報」「今日摘要」「每日簡報」「給我今天的摘要」時使用。`,
    input_schema: {
      type: "object",
      properties: {},
    },
  },
];

module.exports = { tools };
