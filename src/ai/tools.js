// =============================================
// AI 工具定義（RPA 版）
// Claude 可以使用的工具，包含：
// - 航空公司官網查現金票
// - 航空公司官網查里程票
// - 完整比價（現金+里程）
// - 取得訂票連結
// =============================================

const tools = [
  {
    name: "search_all_flights",
    description: `完整比價搜尋：同時查詢多家航空公司的現金票和里程兌換票。
這是最常用的工具，當使用者想查機票、找航班、比價時使用。
會同時查詢華航、長榮、星宇的官網，並比較現金買票和里程兌換哪個更划算。
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
          items: { type: "string", enum: ["CI", "BR", "JX"] },
          description: "指定航空公司代碼。空陣列=查全部。CI=華航, BR=長榮, JX=星宇",
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
          items: { type: "string", enum: ["CI", "BR", "JX"] },
          description: "指定航空公司。空陣列=查全部。",
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
          items: { type: "string", enum: ["CI", "BR", "JX"] },
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
];

module.exports = { tools };
