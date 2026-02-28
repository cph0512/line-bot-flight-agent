// =============================================
// LINE Flex Messages — 航班比價表格（去程 + 回程）
//
// 使用 Carousel 格式：
// Bubble 1 = 去程航班表格
// Bubble 2 = 回程航班表格（如果有）
// =============================================

const AIRLINE_COLORS = {
  CI: "#D7177E", BR: "#00694A", JX: "#8B6914",
  EK: "#D71921", TK: "#C80815", CX: "#006564", SQ: "#F2A900",
};

const AIRLINE_NAMES_SHORT = {
  CI: "華航", BR: "長榮", JX: "星宇",
  EK: "阿聯酋", TK: "土航", CX: "國泰", SQ: "新航",
};

const AIRCRAFT_SHORT = {
  "359": "A350", "35K": "A350", "351": "A350-1000",
  "789": "B787-9", "78J": "B787-9", "788": "B787-8",
  "77W": "B777-300ER", "773": "B777-300", "772": "B777-200",
  "333": "A330-300", "332": "A330-200", "339": "A330neo",
  "321": "A321", "320": "A320", "738": "B737-800",
  "388": "A380", "744": "B747",
};

/**
 * 建立航班比價 Flex Message（支援去程+回程）
 *
 * @param {Array} outboundFlights - 去程航班
 * @param {Array} inboundFlights  - 回程航班（可為空）
 */
function createFlightComparisonFlex(outboundFlights, inboundFlights = []) {
  if (!Array.isArray(outboundFlights) || outboundFlights.length === 0) return null;

  const hasReturn = Array.isArray(inboundFlights) && inboundFlights.length > 0;
  const isRoundTrip = hasReturn || outboundFlights[0]?.isRoundTrip;

  const bubbles = [];

  // Bubble 1：去程
  bubbles.push(
    buildFlightBubble(outboundFlights, {
      title: "✈️ 去程航班",
      headerColor: "#1a73e8",
      isRoundTrip,
      showPrice: true,
    })
  );

  // Bubble 2：回程（如果有）
  if (hasReturn) {
    bubbles.push(
      buildFlightBubble(inboundFlights, {
        title: "🔙 回程航班",
        headerColor: "#e86a1a",
        isRoundTrip: false,
        showPrice: false, // 回程不重複顯示價格（價格是來回總價，已在去程顯示）
      })
    );
  }

  // 單一 bubble 就用 bubble，多個用 carousel
  if (bubbles.length === 1) {
    return {
      type: "flex",
      altText: buildAltText(outboundFlights, isRoundTrip),
      contents: bubbles[0],
    };
  }

  return {
    type: "flex",
    altText: buildAltText(outboundFlights, isRoundTrip),
    contents: {
      type: "carousel",
      contents: bubbles,
    },
  };
}

/**
 * 建立單一方向的航班表格 Bubble
 */
function buildFlightBubble(flights, { title, headerColor, isRoundTrip, showPrice }) {
  const displayFlights = flights.slice(0, 8); // LINE body 高度限制

  // 表格行
  const tableRows = [];

  // 表頭
  const headerCols = [
    { type: "text", text: "航空/航班", size: "xxs", color: "#888888", flex: 3, weight: "bold" },
    { type: "text", text: "出發→抵達", size: "xxs", color: "#888888", flex: 3, weight: "bold" },
    { type: "text", text: "機型", size: "xxs", color: "#888888", flex: 2, weight: "bold" },
  ];
  if (showPrice) {
    headerCols.push({ type: "text", text: isRoundTrip ? "來回價" : "票價", size: "xxs", color: "#888888", flex: 2, weight: "bold", align: "end" });
  } else {
    headerCols.push({ type: "text", text: "飛行", size: "xxs", color: "#888888", flex: 2, weight: "bold", align: "end" });
  }

  tableRows.push({
    type: "box",
    layout: "horizontal",
    contents: headerCols,
    paddingBottom: "6px",
  });

  tableRows.push({ type: "separator" });

  // 資料行
  displayFlights.forEach((f, i) => {
    const airline = AIRLINE_NAMES_SHORT[f.airline] || f.airlineName || f.airline || "?";
    const flightNum = f.flightNumber || "";
    const departTime = f.departTime || "--:--";
    const arriveTime = f.arriveTime || "--:--";
    const aircraft = AIRCRAFT_SHORT[f.aircraft] || f.aircraft || "";
    const price = typeof f.price === "number" ? f.price.toLocaleString() : "—";
    const stops = f.stops === 0 ? "直飛" : f.stops > 0 ? `轉${f.stops}` : "";
    const stopsColor = f.stops === 0 ? "#188038" : "#CC6600";
    const color = AIRLINE_COLORS[f.airline] || "#333333";
    const durationText = f.duration || "";

    // 最後一欄：去程顯示價格，回程顯示飛行時間
    const lastCol = showPrice
      ? { type: "text", text: price, size: "xs", weight: "bold", color: "#CC0000", flex: 2, align: "end", gravity: "center" }
      : { type: "text", text: durationText || "—", size: "xxs", color: "#666666", flex: 2, align: "end", gravity: "center" };

    tableRows.push({
      type: "box",
      layout: "horizontal",
      contents: [
        {
          type: "box",
          layout: "vertical",
          flex: 3,
          contents: [
            { type: "text", text: airline, size: "xs", weight: "bold", color },
            { type: "text", text: flightNum, size: "xxs", color: "#888888" },
          ],
        },
        {
          type: "box",
          layout: "vertical",
          flex: 3,
          contents: [
            { type: "text", text: `${departTime}→${arriveTime}`, size: "xs", color: "#333333" },
            {
              type: "box",
              layout: "horizontal",
              contents: [
                { type: "text", text: stops, size: "xxs", color: stopsColor, flex: 0 },
                showPrice && durationText
                  ? { type: "text", text: ` ${durationText}`, size: "xxs", color: "#999999", flex: 0 }
                  : { type: "filler" },
              ],
            },
          ],
        },
        { type: "text", text: aircraft || "—", size: "xxs", color: "#666666", flex: 2, gravity: "center" },
        lastCol,
      ],
      paddingTop: "8px",
      paddingBottom: "8px",
    });

    // 分隔線（最後一行不加）
    if (i < displayFlights.length - 1) {
      tableRows.push({ type: "separator", color: "#F0F0F0" });
    }
  });

  // 組合 Bubble
  const bubble = {
    type: "bubble",
    size: "mega",
    header: {
      type: "box",
      layout: "vertical",
      contents: [
        {
          type: "box",
          layout: "horizontal",
          contents: [
            { type: "text", text: title, size: "md", weight: "bold", color: "#FFFFFF", flex: 0 },
            { type: "text", text: `${displayFlights.length}筆`, size: "sm", color: "#FFFFFFCC", align: "end" },
          ],
        },
        buildSubtitleRow(displayFlights[0]),
      ],
      backgroundColor: headerColor,
      paddingAll: "16px",
    },
    body: {
      type: "box",
      layout: "vertical",
      contents: tableRows,
      paddingAll: "12px",
    },
  };

  // Footer
  const cheapest = displayFlights[0];
  if (cheapest && showPrice && cheapest.price) {
    const priceLabel = isRoundTrip ? "來回最低" : "最低";
    bubble.footer = {
      type: "box",
      layout: "vertical",
      contents: [
        {
          type: "box",
          layout: "horizontal",
          contents: [
            { type: "text", text: `💰 ${priceLabel} TWD ${cheapest.price.toLocaleString()}`, size: "sm", weight: "bold", color: "#CC0000", flex: 0 },
          ],
        },
      ],
      paddingAll: "12px",
      backgroundColor: "#FFF8F8",
    };
  }

  return bubble;
}

/**
 * 副標題行（路線+艙等）
 */
function buildSubtitleRow(flight) {
  if (!flight) return { type: "filler" };

  const parts = [];
  if (flight.departAirport && flight.arriveAirport) {
    parts.push(`${flight.departAirport}→${flight.arriveAirport}`);
  }
  if (flight.cabinName) {
    parts.push(flight.cabinName);
  }
  const text = parts.join(" | ") || "航班資訊";

  return {
    type: "text",
    text,
    size: "xs",
    color: "#FFFFFFAA",
    margin: "sm",
  };
}

/**
 * Alt text for notification
 */
function buildAltText(outboundFlights, isRoundTrip) {
  const count = outboundFlights.length;
  const cheapest = outboundFlights[0]?.price;
  const priceText = cheapest ? `TWD ${cheapest.toLocaleString()}` : "—";
  const label = isRoundTrip ? "來回最低" : "最低";
  return `找到 ${count} 筆航班 | ${label} ${priceText}`;
}

/**
 * 歡迎訊息
 */
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
          { type: "text", text: "即時查詢全球航班，幫你比價！", size: "sm", wrap: true, margin: "md" },
          { type: "text", text: "💰 多家航空比價表格\n✈️ 航班資訊 + 機型 + 票價\n🔍 篩選艙等與航空公司", size: "sm", wrap: true, margin: "md", color: "#555" },
          { type: "separator", margin: "lg" },
          { type: "text", text: "支援：華航 / 長榮 / 星宇 / 阿聯酋 / 土航 / 國泰 / 新航", size: "xs", wrap: true, margin: "md", color: "#888" },
          { type: "separator", margin: "md" },
          { type: "text", text: "試試看跟我說：\n「台北飛東京 3/15到3/20 兩個人」\n「台北飛洛杉磯 豪華經濟艙 華航長榮比較」", size: "sm", wrap: true, margin: "md", color: "#1a73e8" },
        ],
      },
    },
  };
}

module.exports = { createWelcomeMessage, createFlightComparisonFlex };
