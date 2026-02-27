// =============================================
// 爬蟲測試腳本
// 用法：node src/scraper/test.js
// 可以獨立測試爬蟲，不需要啟動 LINE Bot
// =============================================

require("dotenv").config();

const { searchAll, formatResultsForAI, getBookingLinks } = require("./scraperEngine");
const { shutdown } = require("./browserManager");

async function main() {
  console.log("=== 🧪 爬蟲測試 ===\n");

  const params = {
    origin: "TPE",
    destination: "NRT",
    departDate: "2025-04-15",
    returnDate: "2025-04-20",
    adults: 1,
  };

  console.log("搜尋參數：", params);
  console.log("\n正在查詢各航空公司官網...\n");

  try {
    // 測試完整比價
    const result = await searchAll(params);
    const summary = formatResultsForAI(result);
    console.log(summary);

    // 測試訂票連結
    console.log("\n=== 訂票連結 ===");
    const links = getBookingLinks(params);
    links.forEach((l) => console.log(`${l.airline}: ${l.url}`));

  } catch (error) {
    console.error("測試失敗：", error.message);
  } finally {
    await shutdown();
    process.exit(0);
  }
}

main();
