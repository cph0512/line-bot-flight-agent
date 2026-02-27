# ✈️ LINE Bot 智能機票助手（RPA 版）

結合 Claude AI + Playwright RPA 的 LINE Bot，能**直接到各航空公司官網**查詢：
- 💰 現金票價
- 🎯 里程兌換票價
- 📊 跨航空公司比價（含里程 vs 現金最划算分析）

---

## 🏗️ 架構設計

```
使用者 (LINE)
    ↓
LINE Bot Server (Express)
    ↓
Claude AI Agent (理解意圖、呼叫工具、產生建議)
    ↓
Playwright RPA 爬蟲引擎
    ↓
┌─────────────────────────────────────────────┐
│  華航官網  │  長榮官網  │  星宇官網  │ ...  │
│  (現金票)  │  (現金票)  │  (現金票)  │      │
│  (里程票)  │  (里程票)  │  (里程票)  │      │
└─────────────────────────────────────────────┘
```

### 為什麼用 RPA 而不是 API？

1. **里程票沒有公開 API** - 只有官網能查到里程兌換價
2. **各航空公司定價策略不同** - 官網才是最準確的來源
3. **可以比較現金 vs 里程** - 幫使用者算出最划算的方式

---

## 📁 專案結構

```
line-bot-flight-agent/
├── src/
│   ├── index.js                    # 主程式入口
│   ├── config.js                   # 環境變數設定
│   ├── line/
│   │   ├── lineClient.js           # LINE SDK
│   │   ├── lineHandler.js          # LINE 訊息處理
│   │   └── flexMessages.js         # 卡片式訊息模板
│   ├── ai/
│   │   ├── claudeAgent.js          # Claude AI Agent（核心大腦）
│   │   └── tools.js                # AI 可使用的工具
│   ├── scraper/
│   │   ├── browserManager.js       # Playwright 瀏覽器管理
│   │   ├── scraperEngine.js        # 爬蟲引擎（統一介面）
│   │   └── airlines/
│   │       ├── chinaAirlines.js    # 華航爬蟲
│   │       ├── evaAir.js           # 長榮爬蟲
│   │       └── starlux.js          # 星宇爬蟲
│   └── utils/
│       ├── logger.js
│       └── helpers.js
├── .env.example
├── package.json
└── README.md
```

---

## 🚀 快速開始

### 第一步：安裝 Node.js

前往 https://nodejs.org 下載 **LTS 版本**（v18+）

### 第二步：申請 API Key

#### 🔹 LINE Bot
1. https://developers.line.biz/console/
2. 建立 Provider → Messaging API Channel
3. 記下 **Channel Access Token** 和 **Channel Secret**
4. 關閉 Auto-reply messages

#### 🔹 Claude API
1. https://console.anthropic.com/
2. 取得 **API Key**

### 第三步：安裝與設定

```bash
cd line-bot-flight-agent
npm install

# 安裝 Playwright 瀏覽器（這步會下載 Chromium，約 200MB）
npx playwright install chromium

# 設定環境變數
cp .env.example .env
# 編輯 .env 填入你的 API Key
```

### 第四步：啟動

```bash
npm run dev      # 開發模式
npm start        # 正式模式
```

### 第五步：設定 LINE Webhook

```bash
# 用 ngrok 取得公開網址
ngrok http 3000

# 把 https://xxxx.ngrok-free.app/webhook 貼到 LINE Developer Console
```

---

## 💬 使用方式

```
你：台北飛東京 3月15到20號 兩個人
Bot：🔍 正在查詢各航空公司...

    ✈️ 查詢結果比較：

    【現金票】
    1. 星宇航空 直飛 NT$12,500 ⭐最便宜
    2. 華航 直飛 NT$13,200
    3. 長榮 直飛 NT$14,800

    【里程票】
    1. 長榮 30,000哩 + NT$2,800稅金
    2. 華航 25,000哩 + NT$3,200稅金

    💡 建議：如果你有長榮里程超過30,000哩，
    用里程換比現金買便宜約 NT$12,000！

你：幫我看華航里程票的細節
Bot：...
```

---

## 🔧 新增航空公司爬蟲

每家航空公司的爬蟲是獨立模組，要新增一家只需：

1. 在 `src/scraper/airlines/` 新增檔案
2. 實作 `searchCash()` 和 `searchMiles()` 方法
3. 在 `scraperEngine.js` 註冊

詳見 `src/scraper/airlines/` 內的範例。

---

## ⚠️ 重要注意事項

1. **航空公司網站經常改版** - 爬蟲可能需要定期維護
2. **不要太頻繁查詢** - 建議加入快取和間隔限制，避免被封鎖
3. **不自動訂票** - 只查詢和比價，提供連結讓使用者自己訂
4. **里程登入** - 查里程票可能需要登入會員帳號
5. **法律風險** - 部分航空公司 TOS 禁止自動化存取，請自行評估

---

## 🗺️ 開發路線圖

- [x] Phase 1：基礎架構 + LINE Bot + Claude AI
- [x] Phase 2：Playwright RPA 爬蟲引擎
- [x] Phase 3：華航/長榮/星宇 現金票查詢
- [ ] Phase 4：里程票查詢（需登入功能）
- [ ] Phase 5：更多航空公司（酷航、虎航、樂桃等）
- [ ] Phase 6：快取機制 + 價格追蹤提醒
- [ ] Phase 7：部署到雲端（Railway/Render）
