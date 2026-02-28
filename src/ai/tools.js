// =============================================
// AI 工具定義（全能管家版 v4 — Gemini 優化）
// 工具描述精簡化，提升 Gemini 辨識率
// =============================================

const tools = [
  {
    name: "search_all_flights",
    description: "【備援-請勿主動使用】Amadeus 航班搜尋，僅在 search_google_flights 無法使用時才用。",
    input_schema: {
      type: "object",
      properties: {
        origin: { type: "string", description: "出發機場 IATA 代碼，例如 TPE" },
        destination: { type: "string", description: "目的地機場 IATA 代碼，例如 NRT" },
        departDate: { type: "string", description: "出發日期 YYYY-MM-DD" },
        returnDate: { type: "string", description: "回程日期 YYYY-MM-DD（單程不填）" },
        adults: { type: "integer", description: "成人人數，預設 1" },
        airlines: {
          type: "array",
          items: { type: "string", enum: ["CI", "BR", "JX", "EK", "TK", "CX", "SQ"] },
          description: "指定航空公司代碼。CI=華航, BR=長榮, JX=星宇, EK=阿聯酋, TK=土航, CX=國泰, SQ=新航",
        },
        cabinClass: {
          type: "string",
          enum: ["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"],
          description: "艙等：ECONOMY=經濟, BUSINESS=商務, FIRST=頭等",
        },
      },
      required: ["origin", "destination", "departDate"],
    },
  },
  {
    name: "search_cash_only",
    description: "【備援-請勿主動使用】Amadeus 現金票搜尋，僅在 search_google_flights 無法使用時才用。",
    input_schema: {
      type: "object",
      properties: {
        origin: { type: "string", description: "出發機場 IATA 代碼" },
        destination: { type: "string", description: "目的地機場 IATA 代碼" },
        departDate: { type: "string", description: "出發日期 YYYY-MM-DD" },
        returnDate: { type: "string", description: "回程日期 YYYY-MM-DD" },
        adults: { type: "integer", description: "成人人數" },
        airlines: {
          type: "array",
          items: { type: "string", enum: ["CI", "BR", "JX", "EK", "TK", "CX", "SQ"] },
          description: "指定航空公司",
        },
        cabinClass: {
          type: "string",
          enum: ["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"],
          description: "艙等篩選",
        },
      },
      required: ["origin", "destination", "departDate"],
    },
  },
  {
    name: "search_miles_only",
    description: "【備援】查里程兌換票。用里程換機票時使用。Google Flights 不支援里程查詢。",
    input_schema: {
      type: "object",
      properties: {
        origin: { type: "string", description: "出發機場 IATA 代碼" },
        destination: { type: "string", description: "目的地機場 IATA 代碼" },
        departDate: { type: "string", description: "出發日期 YYYY-MM-DD" },
        returnDate: { type: "string", description: "回程日期 YYYY-MM-DD" },
        adults: { type: "integer", description: "成人人數" },
        airlines: {
          type: "array",
          items: { type: "string", enum: ["CI", "BR", "JX", "EK", "TK", "CX", "SQ"] },
          description: "指定航空公司",
        },
      },
      required: ["origin", "destination", "departDate"],
    },
  },
  {
    name: "get_booking_links",
    description: "產生訂票連結。使用者選好航班要訂票時使用。",
    input_schema: {
      type: "object",
      properties: {
        origin: { type: "string", description: "出發機場 IATA 代碼" },
        destination: { type: "string", description: "目的地機場 IATA 代碼" },
        departDate: { type: "string", description: "出發日期 YYYY-MM-DD" },
        returnDate: { type: "string", description: "回程日期 YYYY-MM-DD" },
        adults: { type: "integer", description: "成人人數" },
      },
      required: ["origin", "destination", "departDate"],
    },
  },
  {
    name: "get_weather",
    description: "查天氣預報。使用者問天氣、溫度、下雨、穿什麼時使用。支援台灣和國際城市。",
    input_schema: {
      type: "object",
      properties: {
        city: { type: "string", description: "城市名稱，例如：台北、東京、Tokyo、London" },
        days: { type: "integer", description: "預報天數 1-7，預設 1" },
      },
      required: ["city"],
    },
  },
  {
    name: "get_news",
    description: "查新聞。使用者問新聞、今天新聞、台灣新聞、國際新聞、科技新聞、財經新聞、體育新聞時使用。",
    input_schema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["general", "business", "technology", "sports", "entertainment", "health", "science"],
          description: "分類：general=綜合, business=財經, technology=科技, sports=體育",
        },
        count: { type: "integer", description: "新聞筆數 1-10，預設 7" },
        region: {
          type: "string",
          enum: ["tw", "world"],
          description: "地區：tw=台灣（預設），world=國際",
        },
      },
      required: ["category"],
    },
  },
  {
    name: "get_events",
    description: "查行事曆。使用者問今天行程、這週行程、明天行事曆時使用。",
    input_schema: {
      type: "object",
      properties: {
        calendarName: { type: "string", description: "行事曆名稱，空=個人，全家=全部" },
        startDate: { type: "string", description: "開始日期 YYYY-MM-DD" },
        endDate: { type: "string", description: "結束日期 YYYY-MM-DD" },
      },
      required: [],
    },
  },
  {
    name: "add_event",
    description: "新增行事曆事件。使用者說加行程、新增會議時使用。",
    input_schema: {
      type: "object",
      properties: {
        calendarName: { type: "string", description: "行事曆名稱" },
        summary: { type: "string", description: "事件標題" },
        startTime: { type: "string", description: "開始時間 YYYY-MM-DDTHH:mm:ss 或 YYYY-MM-DD" },
        endTime: { type: "string", description: "結束時間 YYYY-MM-DDTHH:mm:ss 或 YYYY-MM-DD" },
        description: { type: "string", description: "事件說明" },
      },
      required: ["summary", "startTime", "endTime"],
    },
  },
  {
    name: "update_event",
    description: "更新行事曆事件。需要 eventId（從 get_events 取得）。",
    input_schema: {
      type: "object",
      properties: {
        eventId: { type: "string", description: "事件 ID" },
        calendarName: { type: "string", description: "行事曆名稱" },
        summary: { type: "string", description: "新標題" },
        startTime: { type: "string", description: "新開始時間" },
        endTime: { type: "string", description: "新結束時間" },
        description: { type: "string", description: "新說明" },
      },
      required: ["eventId"],
    },
  },
  {
    name: "delete_event",
    description: "刪除行事曆事件。需要 eventId（從 get_events 取得）。",
    input_schema: {
      type: "object",
      properties: {
        eventId: { type: "string", description: "事件 ID" },
        calendarName: { type: "string", description: "行事曆名稱" },
      },
      required: ["eventId"],
    },
  },
  {
    name: "trigger_briefing",
    description: "觸發每日晨報早報。使用者說早報、晨報、今日摘要、每日簡報、晨報測試時使用。",
    input_schema: {
      type: "object",
      properties: {
        _placeholder: { type: "string", description: "不需要參數，留空即可" },
      },
      required: [],
    },
  },
  {
    name: "search_google_flights",
    description: "【主要工具】搜尋機票比價。查航班、查機票、找便宜機票、比價時一律使用此工具。資料來自 Google Flights，票價最即時準確。",
    input_schema: {
      type: "object",
      properties: {
        origin: { type: "string", description: "出發機場 IATA 代碼，例如 TPE" },
        destination: { type: "string", description: "目的地機場 IATA 代碼，例如 NRT" },
        departDate: { type: "string", description: "出發日期 YYYY-MM-DD" },
        returnDate: { type: "string", description: "回程日期 YYYY-MM-DD（單程不填）" },
        adults: { type: "integer", description: "成人人數，預設 1" },
        children: { type: "integer", description: "兒童人數 (2-11歲)，預設 0" },
        cabinClass: {
          type: "string",
          enum: ["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"],
          description: "艙等：ECONOMY=經濟, PREMIUM_ECONOMY=豪經, BUSINESS=商務, FIRST=頭等",
        },
      },
      required: ["origin", "destination", "departDate"],
    },
  },
  {
    name: "search_airport",
    description: "搜尋機場代碼。使用者說城市名但不確定機場代碼時使用，例如「大阪」找到 KIX/ITM。",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "城市名或機場名稱，例如：大阪、Bangkok、LAX" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_flight_prices",
    description: "查詢航班價格日曆，找出最便宜的出發日期。適合彈性日期的使用者。",
    input_schema: {
      type: "object",
      properties: {
        origin: { type: "string", description: "出發機場 IATA 代碼" },
        destination: { type: "string", description: "目的地機場 IATA 代碼" },
        departDate: { type: "string", description: "預計出發日期 YYYY-MM-DD（會顯示前後日期的價格）" },
        returnDate: { type: "string", description: "預計回程日期 YYYY-MM-DD" },
      },
      required: ["origin", "destination", "departDate"],
    },
  },
  {
    name: "search_web",
    description: "上網搜尋即時資訊。當使用者問的問題需要最新資料時使用，例如：股價、賽程、活動時間、餐廳推薦、任何你不確定的事實。優先使用此工具查詢，不要自己猜測。",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜尋關鍵字，用中文或英文皆可" },
        count: { type: "integer", description: "回傳筆數 1-8，預設 5" },
      },
      required: ["query"],
    },
  },
];

module.exports = { tools };
