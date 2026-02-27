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
    EK: { id: process.env.EK_MEMBER_ID, password: process.env.EK_MEMBER_PASSWORD },
    TK: { id: process.env.TK_MEMBER_ID, password: process.env.TK_MEMBER_PASSWORD },
    CX: { id: process.env.CX_MEMBER_ID, password: process.env.CX_MEMBER_PASSWORD },
    SQ: { id: process.env.SQ_MEMBER_ID, password: process.env.SQ_MEMBER_PASSWORD },
  },
  server: {
    port: process.env.PORT || 3000,
    nodeEnv: process.env.NODE_ENV || "development",
  },
};

// 檢查是否為佔位符值
function isPlaceholder(val) {
  if (!val) return true;
  const placeholders = ["your_token", "your_secret", "your_key", "YOUR_", "REPLACE_ME", "xxx", "changeme"];
  return placeholders.some((p) => val.toLowerCase().includes(p.toLowerCase()));
}

function validateConfig() {
  const required = [
    ["LINE_CHANNEL_ACCESS_TOKEN", config.line.channelAccessToken],
    ["LINE_CHANNEL_SECRET", config.line.channelSecret],
    ["ANTHROPIC_API_KEY", config.anthropic.apiKey],
  ];

  const missing = required.filter(([, v]) => !v || isPlaceholder(v));
  if (missing.length > 0) {
    console.error("=".repeat(50));
    console.error("  缺少或無效的環境變數：");
    missing.forEach(([n, v]) => {
      const reason = !v ? "未設定" : "仍為佔位符值";
      console.error(`  - ${n} (${reason})`);
    });
    console.error("");
    console.error("  請在 Railway 環境變數或 .env 中設定真實的值");
    console.error("=".repeat(50));
    process.exit(1);
  }

  // 顯示 API key 前幾個字元（確認設定正確）
  console.log(`[Config] ANTHROPIC_API_KEY: ${config.anthropic.apiKey.slice(0, 12)}...`);
  console.log(`[Config] ANTHROPIC_MODEL: ${config.anthropic.model}`);

  // 里程帳號提醒
  const noMileage = Object.entries(config.mileageAccounts)
    .filter(([, v]) => !v.id)
    .map(([k]) => k);
  if (noMileage.length > 0) {
    console.log(`[Config] 未設定里程帳號：${noMileage.join(", ")}（只能查現金票）`);
  }
}

module.exports = { config, validateConfig };
