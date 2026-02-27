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
          { type: "text", text: "支援：華航 / 長榮 / 星宇", size: "xs", wrap: true, margin: "md", color: "#888" },
          { type: "separator", margin: "md" },
          { type: "text", text: "試試看跟我說：\n「台北飛東京 3/15到3/20 兩個人」\n「我有5萬長榮哩程，飛大阪划算嗎？」", size: "sm", wrap: true, margin: "md", color: "#1a73e8" },
        ],
      },
    },
  };
}

module.exports = { createWelcomeMessage };
