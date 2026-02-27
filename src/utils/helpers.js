const dayjs = require("dayjs");

// 城市中文名 → IATA 機場代碼
const CITY_TO_IATA = {
  台北: "TPE", 桃園: "TPE", 松山: "TSA", 高雄: "KHH", 台中: "RMQ",
  東京: "NRT", 成田: "NRT", 羽田: "HND", 大阪: "KIX", 關西: "KIX",
  名古屋: "NGO", 福岡: "FUK", 札幌: "CTS", 沖繩: "OKA",
  首爾: "ICN", 仁川: "ICN", 釜山: "PUS",
  曼谷: "BKK", 新加坡: "SIN", 吉隆坡: "KUL", 胡志明: "SGN",
  河內: "HAN", 峇里島: "DPS", 馬尼拉: "MNL",
  香港: "HKG", 上海: "PVG", 北京: "PEK",
  倫敦: "LHR", 巴黎: "CDG", 紐約: "JFK", 洛杉磯: "LAX",
  舊金山: "SFO", 雪梨: "SYD", 溫哥華: "YVR",
};

const IATA_TO_CITY = {};
for (const [city, code] of Object.entries(CITY_TO_IATA)) {
  if (!IATA_TO_CITY[code]) IATA_TO_CITY[code] = city;
}

// 航空公司代碼
const AIRLINES = {
  CI: { name: "華航", fullName: "中華航空", code: "CI", alliance: "天合聯盟" },
  BR: { name: "長榮", fullName: "長榮航空", code: "BR", alliance: "星空聯盟" },
  JX: { name: "星宇", fullName: "星宇航空", code: "JX", alliance: "無" },
  IT: { name: "台灣虎航", fullName: "台灣虎航", code: "IT", alliance: "無" },
  MM: { name: "樂桃", fullName: "樂桃航空", code: "MM", alliance: "無" },
  TR: { name: "酷航", fullName: "酷航", code: "TR", alliance: "無" },
};

function formatPrice(amount, currency = "TWD") {
  const s = { TWD: "NT$", USD: "US$", EUR: "€", JPY: "¥", KRW: "₩" };
  return `${s[currency] || currency} ${Number(amount).toLocaleString()}`;
}

function formatMiles(miles) {
  return `${Number(miles).toLocaleString()} 哩`;
}

function formatDuration(minutes) {
  if (!minutes) return "未知";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}小時${m > 0 ? m + "分" : ""}`;
}

function formatDate(dateStr) {
  return dayjs(dateStr).format("MM/DD (dd)");
}

function formatTime(timeStr) {
  return dayjs(timeStr).format("HH:mm");
}

// 計算里程的「現金等值」- 用來比較里程票和現金票哪個划算
// 一般認為 1 哩約值 NT$0.3~0.5
function calculateMilesValue(miles, taxes, cashPrice, milesValueRate = 0.4) {
  const milesAsCash = miles * milesValueRate;
  const totalMilesCost = milesAsCash + taxes;
  const savings = cashPrice - taxes;
  const actualMilesValue = miles > 0 ? savings / miles : 0;
  return {
    milesAsCash: Math.round(milesAsCash),
    totalEquivalent: Math.round(totalMilesCost),
    savings: Math.round(savings),
    valuePerMile: Math.round(actualMilesValue * 100) / 100,
    worthIt: actualMilesValue > milesValueRate,
  };
}

module.exports = {
  CITY_TO_IATA,
  IATA_TO_CITY,
  AIRLINES,
  formatPrice,
  formatMiles,
  formatDuration,
  formatDate,
  formatTime,
  calculateMilesValue,
};
