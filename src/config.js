require("dotenv").config();

const config = {
  line: {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET,
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: "claude-sonnet-4-20250514",
  },
  browser: {
    headless: process.env.BROWSER_HEADLESS !== "false",
    maxPages: parseInt(process.env.BROWSER_MAX_PAGES) || 3,
  },
  // 里程帳號（選填）
  mileageAccounts: {
    CI: { id: process.env.CI_MEMBER_ID, password: process.env.CI_MEMBER_PASSWORD },
    BR: { id: process.env.BR_MEMBER_ID, password: process.env.BR_MEMBER_PASSWORD },
    JX: { id: process.env.JX_MEMBER_ID, password: process.env.JX_MEMBER_PASSWORD },
  },
  server: {
    port: process.env.PORT || 3000,
    nodeEnv: process.env.NODE_ENV || "development",
  },
};

function validateConfig() {
  const required = [
    ["LINE_CHANNEL_ACCESS_TOKEN", config.line.channelAccessToken],
    ["LINE_CHANNEL_SECRET", config.line.channelSecret],
    ["ANTHROPIC_API_KEY", config.anthropic.apiKey],
  ];
  const missing = required.filter(([, v]) => !v);
  if (missing.length > 0) {
    console.error("❌ 缺少環境變數：");
    missing.forEach(([n]) => console.error("   - " + n));
    process.exit(1);
  }
  // 里程帳號提醒（非必要）
  const noMileage = Object.entries(config.mileageAccounts)
    .filter(([, v]) => !v.id)
    .map(([k]) => k);
  if (noMileage.length > 0) {
    console.log(`ℹ️  未設定里程帳號：${noMileage.join(", ")}（只能查現金票）`);
  }
}

module.exports = { config, validateConfig };
