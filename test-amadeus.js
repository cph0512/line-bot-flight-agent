#!/usr/bin/env node
/**
 * Amadeus API 測試腳本
 *
 * 使用方式：
 *   設定 .env 中的 AMADEUS_CLIENT_ID 和 AMADEUS_CLIENT_SECRET 後執行：
 *   node test-amadeus.js
 *
 *   或直接傳入參數：
 *   AMADEUS_CLIENT_ID=xxx AMADEUS_CLIENT_SECRET=yyy node test-amadeus.js
 */

require("dotenv").config();

const Amadeus = require("amadeus");

const clientId = process.env.AMADEUS_CLIENT_ID;
const clientSecret = process.env.AMADEUS_CLIENT_SECRET;
const isProduction = process.env.AMADEUS_PRODUCTION === "true";

console.log("=".repeat(50));
console.log("  Amadeus API 測試");
console.log("=".repeat(50));
console.log(`  Client ID:  ${clientId ? clientId.slice(0, 8) + "..." : "❌ 未設定"}`);
console.log(`  Secret:     ${clientSecret ? clientSecret.slice(0, 4) + "..." : "❌ 未設定"}`);
console.log(`  環境:       ${isProduction ? "Production" : "Test"}`);
console.log("=".repeat(50));

if (!clientId || !clientSecret) {
  console.error("\n❌ 請先在 .env 設定 AMADEUS_CLIENT_ID 和 AMADEUS_CLIENT_SECRET");
  console.error("   或用環境變數: AMADEUS_CLIENT_ID=xxx AMADEUS_CLIENT_SECRET=yyy node test-amadeus.js\n");
  process.exit(1);
}

async function test() {
  const amadeus = new Amadeus({
    clientId,
    clientSecret,
    hostname: isProduction ? "production" : "test",
  });

  console.log("\n📡 測試 1: TPE → NRT (東京) 經濟艙...");
  try {
    const departDate = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
    console.log(`   查詢日期: ${departDate}`);

    const response = await amadeus.shopping.flightOffersSearch.get({
      originLocationCode: "TPE",
      destinationLocationCode: "NRT",
      departureDate: departDate,
      adults: "1",
      currencyCode: "TWD",
      max: "5",
    });

    const offers = response.data || [];
    console.log(`   ✅ 成功！收到 ${offers.length} 筆航班報價`);

    if (offers.length > 0) {
      console.log("\n   前 3 筆結果：");
      offers.slice(0, 3).forEach((offer, i) => {
        const price = offer.price;
        const itin = offer.itineraries?.[0];
        const segments = itin?.segments || [];
        const firstSeg = segments[0];
        const lastSeg = segments[segments.length - 1];

        console.log(`   ${i + 1}. ${firstSeg?.carrierCode}${firstSeg?.number} ` +
          `${firstSeg?.departure?.at?.match(/T(\d{2}:\d{2})/)?.[1] || "?"} → ` +
          `${lastSeg?.arrival?.at?.match(/T(\d{2}:\d{2})/)?.[1] || "?"} ` +
          `${price?.currency} ${price?.grandTotal} ` +
          `(${segments.length === 1 ? "直飛" : `轉機${segments.length - 1}次`})`);
      });
    }
  } catch (error) {
    console.error(`   ❌ 失敗: ${error.response?.body ? JSON.stringify(error.response.body).slice(0, 300) : error.message}`);
  }

  console.log("\n📡 測試 2: TPE → LAX (洛杉磯) 豪華經濟艙 華航+長榮+星宇...");
  try {
    const departDate = "2026-03-26";
    console.log(`   查詢日期: ${departDate}`);

    const response = await amadeus.shopping.flightOffersSearch.get({
      originLocationCode: "TPE",
      destinationLocationCode: "LAX",
      departureDate: departDate,
      adults: "1",
      currencyCode: "TWD",
      travelClass: "PREMIUM_ECONOMY",
      includedAirlineCodes: "CI,BR,JX",
      max: "10",
    });

    const offers = response.data || [];
    console.log(`   ✅ 成功！收到 ${offers.length} 筆航班報價`);

    if (offers.length > 0) {
      const dictionaries = response.result?.dictionaries || {};
      console.log("\n   結果：");
      offers.slice(0, 5).forEach((offer, i) => {
        const price = offer.price;
        const itin = offer.itineraries?.[0];
        const segments = itin?.segments || [];
        const firstSeg = segments[0];
        const lastSeg = segments[segments.length - 1];
        const carrier = firstSeg?.carrierCode;
        const carrierName = { CI: "華航", BR: "長榮", JX: "星宇" }[carrier] || carrier;

        console.log(`   ${i + 1}. ${carrierName} ${carrier}${firstSeg?.number} ` +
          `${firstSeg?.departure?.at?.match(/T(\d{2}:\d{2})/)?.[1] || "?"} → ` +
          `${lastSeg?.arrival?.at?.match(/T(\d{2}:\d{2})/)?.[1] || "?"} ` +
          `${price?.currency} ${price?.grandTotal} ` +
          `機型:${firstSeg?.aircraft?.code || "?"} ` +
          `(${segments.length === 1 ? "直飛" : `轉機${segments.length - 1}次`})`);
      });
    }
  } catch (error) {
    console.error(`   ❌ 失敗: ${error.response?.body ? JSON.stringify(error.response.body).slice(0, 300) : error.message}`);
  }

  console.log("\n" + "=".repeat(50));
  console.log("  測試完成！");
  console.log("=".repeat(50) + "\n");
}

test().catch((err) => {
  console.error("測試異常:", err);
  process.exit(1);
});
