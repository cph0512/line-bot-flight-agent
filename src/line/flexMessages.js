// 航空公司品牌色
const AIRLINE_COLORS = {
  CI: "#D7177E", // 華航 pink
  BR: "#00694A", // 長榮 green
  JX: "#8B6914", // 星宇 gold
  EK: "#D71921", // 阿聯酋 red
  TK: "#C80815", // 土航 red
  CX: "#006564", // 國泰 teal
  SQ: "#F2A900", // 新航 gold
};

const DEFAULT_HEADER_COLOR = "#1a237e";

/**
 * 建立航班比價 Flex Message（carousel 最多 10 張卡片）
 *
 * @param {Array} flights - 航班資料陣列
 * @returns {Object|null} LINE Flex Message 或 null（無資料時）
 */
function createFlightComparisonFlex(flights) {
  if (!Array.isArray(flights) || flights.length === 0) return null;

  const bubbles = flights.slice(0, 10).map((flight) => createFlightBubble(flight));

  return {
    type: "flex",
    altText: `找到 ${flights.length} 筆航班比價結果`,
    contents: {
      type: "carousel",
      contents: bubbles,
    },
  };
}

/**
 * 建立單一航班 bubble
 */
function createFlightBubble(f) {
  const airline = f.airline || "";
  const airlineName = f.airlineName || airline || "航空公司";
  const flightNumber = f.flightNumber || "";
  const departTime = f.departTime || "--:--";
  const arriveTime = f.arriveTime || "--:--";
  const duration = f.duration || "";
  const stops = typeof f.stops === "number" ? f.stops : -1;
  const cabinName = f.cabinName || f.cabinClass || "";
  const price = typeof f.price === "number" ? f.price : null;
  const currency = f.currency || "TWD";

  const headerColor = AIRLINE_COLORS[airline] || DEFAULT_HEADER_COLOR;
  const stopsText = stops === 0 ? "直飛" : stops > 0 ? `轉機${stops}次` : "";

  // 價格格式化
  const priceText = price !== null
    ? `${currency} ${price.toLocaleString("en-US")}`
    : "價格洽詢";

  // 訂票連結（使用 Google Flights 作為通用連結）
  const bookingUrl = f.bookingUrl || "https://www.google.com/travel/flights";

  // 時間/中轉 資訊行
  const durationStopsContents = [];
  if (duration) {
    durationStopsContents.push({
      type: "text",
      text: duration,
      size: "sm",
      color: "#555555",
      flex: 0,
    });
  }
  if (duration && stopsText) {
    durationStopsContents.push({
      type: "text",
      text: "|",
      size: "sm",
      color: "#AAAAAA",
      flex: 0,
      margin: "md",
    });
  }
  if (stopsText) {
    durationStopsContents.push({
      type: "text",
      text: stopsText,
      size: "sm",
      color: stops === 0 ? "#00694A" : "#CC6600",
      flex: 0,
      margin: duration ? "md" : "none",
    });
  }

  // body contents
  const bodyContents = [
    // Row 1: 出發 → 到達
    {
      type: "box",
      layout: "horizontal",
      contents: [
        {
          type: "text",
          text: departTime,
          size: "xxl",
          weight: "bold",
          color: "#333333",
          flex: 0,
        },
        {
          type: "text",
          text: "→",
          size: "xl",
          color: "#AAAAAA",
          align: "center",
          gravity: "center",
          flex: 0,
          margin: "md",
        },
        {
          type: "text",
          text: arriveTime,
          size: "xxl",
          weight: "bold",
          color: "#333333",
          flex: 0,
          margin: "md",
        },
      ],
      margin: "md",
    },
  ];

  // Row 2: duration | stops
  if (durationStopsContents.length > 0) {
    bodyContents.push({
      type: "box",
      layout: "horizontal",
      contents: durationStopsContents,
      margin: "sm",
    });
  }

  // Row 3: cabin class
  if (cabinName) {
    bodyContents.push({
      type: "text",
      text: cabinName,
      size: "sm",
      color: "#555555",
      margin: "sm",
    });
  }

  // Separator
  bodyContents.push({ type: "separator", margin: "lg" });

  // Row 4: Price
  bodyContents.push({
    type: "text",
    text: priceText,
    size: "xl",
    weight: "bold",
    color: "#CC0000",
    margin: "lg",
  });

  const bubble = {
    type: "bubble",
    size: "kilo",
    header: {
      type: "box",
      layout: "vertical",
      contents: [
        {
          type: "text",
          text: `${airlineName}  ${flightNumber}`,
          color: "#FFFFFF",
          size: "md",
          weight: "bold",
        },
      ],
      backgroundColor: headerColor,
      paddingAll: "15px",
    },
    body: {
      type: "box",
      layout: "vertical",
      contents: bodyContents,
      paddingAll: "15px",
    },
    footer: {
      type: "box",
      layout: "vertical",
      contents: [
        {
          type: "button",
          action: {
            type: "uri",
            label: "查看詳情",
            uri: bookingUrl,
          },
          style: "primary",
          color: headerColor,
          height: "sm",
        },
      ],
      paddingAll: "10px",
    },
  };

  return bubble;
}

function createWelcomeMessage() {
  return {
    type: "flex",
    altText: "歡迎使用機票助手 ✈️",
    contents: {
      type: "bubble",
      body: {
        type: "box", layout: "vertical", spacing: "md",
        contents: [
          { type: "text", text: "✈️ 智能機票助手", size: "xl", weight: "bold", color: "#1a73e8" },
          { type: "text", text: "直接查詢航空公司官網，幫你比價！", size: "sm", wrap: true, margin: "md" },
          { type: "text", text: "💰 現金票比價\n🎯 里程兌換查詢\n📊 現金 vs 里程划算分析\n🔗 直接訂票連結", size: "sm", wrap: true, margin: "md", color: "#555" },
          { type: "separator", margin: "lg" },
          { type: "text", text: "支援：華航 / 長榮 / 星宇 / 阿聯酋 / 土航 / 國泰 / 新航", size: "xs", wrap: true, margin: "md", color: "#888" },
          { type: "separator", margin: "md" },
          { type: "text", text: "試試看跟我說：\n「台北飛東京 3/15到3/20 兩個人」\n「我有5萬長榮哩程，飛大阪划算嗎？」", size: "sm", wrap: true, margin: "md", color: "#1a73e8" },
        ],
      },
    },
  };
}

module.exports = { createWelcomeMessage, createFlightComparisonFlex };
