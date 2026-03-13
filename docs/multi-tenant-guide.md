# LINE Bot 多租戶 SaaS 架構開發指南

> 本文件整理自 AI 管家 LINE Bot 的實作經驗，可直接複製到其他 LINE Bot 專案使用。

---

## 目錄

1. [架構總覽](#1-架構總覽)
2. [資料庫設計](#2-資料庫設計)
3. [用戶註冊與邀請碼機制](#3-用戶註冊與邀請碼機制)
4. [JWT 認證系統](#4-jwt-認證系統)
5. [Per-User Google 行事曆 OAuth](#5-per-user-google-行事曆-oauth)
6. [多行事曆管理](#6-多行事曆管理)
7. [功能模組開關系統](#7-功能模組開關系統)
8. [超級管理後台](#8-超級管理後台)
9. [Per-User 排程任務](#9-per-user-排程任務)
10. [LINE Webhook 訊息路由](#10-line-webhook-訊息路由)
11. [環境變數清單](#11-環境變數清單)
12. [部署檢查清單](#12-部署檢查清單)

---

## 1. 架構總覽

```
LINE 用戶 A ──┐
LINE 用戶 B ──┤──→ LINE Webhook ──→ lineHandler.js
LINE 用戶 C ──┘         │
                        ├─→ 自動註冊用戶 (PENDING)
                        ├─→ 邀請碼啟用 (ACTIVE)
                        ├─→ 特殊指令 (後台/綁定行事曆/超級後台)
                        └─→ AI Agent 處理訊息
                              │
                              └─→ executeTool() ──→ 各服務 (帶 userId)
                                    │
                                    ├─→ calendarService (per-user OAuth)
                                    ├─→ weatherService (per-user 城市)
                                    ├─→ briefingService (per-user 設定)
                                    └─→ 其他服務...

瀏覽器管理後台:
  /admin/index.html ──→ /api/user/* (JWT 認證, 每個用戶管自己)
  /admin/super.html ──→ /api/admin/* (Owner 專用, 管理所有用戶)
```

### 核心原則

- **每個 LINE userId 對應一個 DB User**
- **所有資料表都有 `userId` 外鍵**，查詢時一律加 `WHERE userId = ?`
- **JWT Token 攜帶 lineUserId**，middleware 解析後載入完整 user 物件
- **Cascade Delete**：刪用戶自動刪除所有關聯資料

---

## 2. 資料庫設計

使用 Prisma ORM + PostgreSQL。

### 核心 Schema

```prisma
// 用戶（根實體）
model User {
  id          String     @id @default(cuid())
  lineUserId  String     @unique
  displayName String?
  pictureUrl  String?
  status      UserStatus @default(PENDING)
  activatedAt DateTime?
  createdAt   DateTime   @default(now())
  updatedAt   DateTime   @updatedAt

  // 1:1 關聯
  googleAuth      GoogleAuth?
  settings        UserSettings?
  briefingConfig  BriefingConfig?

  // 1:N 關聯
  calendars       FamilyCalendar[]
  aiUsageLogs     AiUsageLog[]
  conversations   ConversationMessage[]
  // ...其他功能資料表

  @@index([lineUserId])
}

enum UserStatus {
  PENDING     // 剛加好友，尚未輸入邀請碼
  ACTIVE      // 已啟用
  SUSPENDED   // 被 Owner 停用
}

// 邀請碼
model InvitationCode {
  id        String    @id @default(cuid())
  code      String    @unique
  maxUses   Int       @default(1)
  usedCount Int       @default(0)
  expiresAt DateTime?
  createdBy String?
  createdAt DateTime  @default(now())
}

// Google OAuth（每個用戶一組 Token）
model GoogleAuth {
  id           String   @id @default(cuid())
  userId       String   @unique
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  accessToken  String   @db.Text   // 加密儲存
  refreshToken String   @db.Text   // 加密儲存
  tokenExpiry  DateTime
  email        String?
  calendarId   String?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
}

// 用戶設定
model UserSettings {
  id                  String  @id @default(cuid())
  userId              String  @unique
  user                User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  defaultCity         String  @default("臺北市")
  timezone            String  @default("Asia/Taipei")
  enabledModules      String  @default("[]")  // JSON 字串
}

// 其他行事曆（工作、家庭、私人等）
model FamilyCalendar {
  id             String  @id @default(cuid())
  userId         String
  user           User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  name           String
  calendarId     String
  enabled        Boolean @default(true)
  autoDiscovered Boolean @default(false)

  @@unique([userId, calendarId])
  @@index([userId])
}

// AI 用量追蹤
model AiUsageLog {
  id            String   @id @default(cuid())
  userId        String
  user          User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  provider      String
  model         String
  inputTokens   Int
  outputTokens  Int
  totalTokens   Int
  estimatedCost Float    @default(0)
  createdAt     DateTime @default(now())

  @@index([userId])
  @@index([createdAt])
}
```

### 設計要點

1. **`userId` 一律設 `@index`**：加速 per-user 查詢
2. **`onDelete: Cascade`**：刪用戶時自動清理所有資料
3. **Per-user 唯一約束**：例如 `@@unique([userId, calendarId])` 防止重複
4. **加密敏感資料**：OAuth Token 用 AES 加密後存入

---

## 3. 用戶註冊與邀請碼機制

### 流程

```
用戶第一次傳訊息 → 自動建立 PENDING 帳號
     ↓
用戶輸入邀請碼 → 驗證碼有效性 → 狀態改為 ACTIVE
     ↓
用戶可使用所有功能
```

### 關鍵程式碼

```javascript
// userService.js

// 自動建立用戶（首次訊息時呼叫）
async function findOrCreateUser(lineUserId, profile) {
  return prisma.user.upsert({
    where: { lineUserId },
    update: {
      displayName: profile?.displayName,
      pictureUrl: profile?.pictureUrl,
    },
    create: {
      lineUserId,
      displayName: profile?.displayName || "Unknown",
      pictureUrl: profile?.pictureUrl,
      status: "PENDING",
      settings: {
        create: { defaultCity: "臺北市", timezone: "Asia/Taipei" },
      },
    },
  });
}

// 邀請碼啟用
async function activateUser(lineUserId, code) {
  const invitation = await prisma.invitationCode.findUnique({ where: { code: code.toUpperCase() } });
  if (!invitation) return { success: false, message: "邀請碼不存在" };
  if (invitation.expiresAt && invitation.expiresAt < new Date()) return { success: false, message: "邀請碼已過期" };
  if (invitation.usedCount >= invitation.maxUses) return { success: false, message: "邀請碼已達使用上限" };

  await prisma.$transaction([
    prisma.user.update({
      where: { lineUserId },
      data: { status: "ACTIVE", activatedAt: new Date() },
    }),
    prisma.invitationCode.update({
      where: { code: code.toUpperCase() },
      data: { usedCount: { increment: 1 } },
    }),
  ]);

  return { success: true };
}

// 檢查用戶是否已啟用
async function isActivated(lineUserId) {
  const user = await prisma.user.findUnique({ where: { lineUserId } });
  return user?.status === "ACTIVE";
}
```

### LINE Handler 中的整合

```javascript
// lineHandler.js — 在處理訊息前

// 1. 自動註冊
await userService.findOrCreateUser(lineUserId, profile);

// 2. 檢查邀請碼格式
const INVITATION_CODE_REGEX = /^[A-Z0-9]{6,20}$/i;
if (INVITATION_CODE_REGEX.test(text.trim())) {
  const result = await userService.activateUser(lineUserId, text.trim());
  return result.success
    ? replyText("帳號啟用成功！")
    : replyText(result.message);
}

// 3. 未啟用用戶限制功能
if (!await userService.isActivated(lineUserId)) {
  return replyText("請先輸入邀請碼啟用帳號");
}
```

---

## 4. JWT 認證系統

### Token 產生與驗證

```javascript
// adminAuth.js
const jwt = require("jsonwebtoken");

function generateAdminToken(lineUserId) {
  return jwt.sign({ lineUserId }, SESSION_SECRET, { expiresIn: "24h" });
}

function verifyAdminToken(token) {
  try {
    return jwt.verify(token, SESSION_SECRET);
  } catch {
    return null;
  }
}
```

### Express Middleware

```javascript
async function adminAuthMiddleware(req, res, next) {
  // 從 Header 或 URL 取得 token
  let token = null;
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  } else if (req.query?.token) {
    token = req.query.token;
  }

  if (!token) return res.status(401).json({ error: "未提供認證 token" });

  // 驗證 JWT
  const payload = verifyAdminToken(token);
  if (!payload) return res.status(401).json({ error: "Token 無效或已過期" });

  // 載入用戶到 req
  const user = await prisma.user.findUnique({
    where: { lineUserId: payload.lineUserId },
    include: { settings: true },
  });
  if (!user || user.status !== "ACTIVE") {
    return res.status(403).json({ error: "帳號未啟用" });
  }

  req.userId = user.id;      // DB User.id
  req.user = user;            // 完整 user 物件
  next();
}
```

### 從 LINE Bot 取得後台連結

```javascript
// lineHandler.js
if (["後台", "admin", "管理", "設定"].includes(text)) {
  const token = generateAdminToken(lineUserId);
  const url = `${APP_URL}/admin?token=${token}`;
  return replyText(`你的後台管理連結（24小時有效）：\n${url}`);
}
```

### 前端 Token 處理

```javascript
// admin/index.html
function checkUrlToken() {
  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get('token');
  if (urlToken) {
    token = urlToken;
    localStorage.setItem('admin_token', token);
    window.history.replaceState({}, '', window.location.pathname);
    return true;
  }
  return false;
}
```

---

## 5. Per-User Google 行事曆 OAuth

### 環境設定

```env
GOOGLE_OAUTH_CLIENT_ID=你的client-id.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-你的secret
```

Google Cloud Console 設定：
1. 建立 OAuth 2.0 Client ID (Web application)
2. Redirect URI: `https://你的域名/auth/google/callback`
3. OAuth 同意畫面設為 External，加測試用戶

### OAuth 流程

```javascript
// googleOAuth.js

const SCOPES = ["https://www.googleapis.com/auth/calendar"];

// 1. 產生授權 URL（lineUserId 加密放在 state）
function generateAuthUrl(lineUserId) {
  const client = createOAuth2Client();
  const state = encrypt(lineUserId, SESSION_SECRET);
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state,
  });
}

// 2. 交換授權碼取得 Token + 所有行事曆
async function exchangeCode(code, state) {
  const client = createOAuth2Client();
  const lineUserId = decrypt(state, SESSION_SECRET);
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  const calendar = google.calendar({ version: "v3", auth: client });
  const calendarList = await calendar.calendarList.list();
  const items = calendarList.data.items || [];
  const primary = items.find((c) => c.primary);

  // 收集非主要行事曆
  const allCalendars = items
    .filter((c) => !c.primary && c.accessRole !== "freeBusyReader")
    .map((c) => ({
      calendarId: c.id,
      name: c.summaryOverride || c.summary || c.id,
    }));

  return {
    tokens, lineUserId,
    calendarId: primary?.id || "primary",
    email: primary?.id,
    allCalendars,
  };
}

// 3. 加密儲存 Token
async function saveTokens(lineUserId, tokens, calendarId, email) {
  const user = await prisma.user.findUnique({ where: { lineUserId } });
  await prisma.googleAuth.upsert({
    where: { userId: user.id },
    update: {
      accessToken: encrypt(tokens.access_token, SECRET),
      refreshToken: encrypt(tokens.refresh_token, SECRET),
      tokenExpiry: new Date(tokens.expiry_date),
      calendarId, email,
    },
    create: {
      userId: user.id,
      accessToken: encrypt(tokens.access_token, SECRET),
      refreshToken: encrypt(tokens.refresh_token, SECRET),
      tokenExpiry: new Date(tokens.expiry_date),
      calendarId, email,
    },
  });
}

// 4. 取得用戶的 Calendar Client（自動 Refresh）
async function getCalendarClientForUser(userId) {
  const auth = await prisma.googleAuth.findUnique({ where: { userId } });
  if (!auth) return null;

  const client = createOAuth2Client();
  client.setCredentials({
    access_token: decrypt(auth.accessToken, SECRET),
    refresh_token: decrypt(auth.refreshToken, SECRET),
    expiry_date: auth.tokenExpiry.getTime(),
  });

  // Token 快過期時自動 Refresh
  if (auth.tokenExpiry.getTime() < Date.now() + 5 * 60 * 1000) {
    const { credentials } = await client.refreshAccessToken();
    client.setCredentials(credentials);
    await prisma.googleAuth.update({
      where: { userId },
      data: {
        accessToken: encrypt(credentials.access_token, SECRET),
        tokenExpiry: new Date(credentials.expiry_date),
      },
    });
  }

  return google.calendar({ version: "v3", auth: client });
}
```

### LINE WebView 相容處理

Google OAuth 在 LINE 內建瀏覽器（WebView）中會被封鎖，需要偵測並導引用戶使用外部瀏覽器：

```javascript
app.get("/auth/google/start", async (req, res) => {
  // 偵測 LINE WebView
  const userAgent = req.headers["user-agent"] || "";
  const isLineWebView = /Line\//i.test(userAgent);

  const url = googleOAuth.generateAuthUrl(lineUserId);

  if (isLineWebView) {
    // 顯示中間頁面，引導用戶在外部瀏覽器開啟
    return res.send(`<html>
      <body style="text-align:center;padding:40px">
        <h2>請在瀏覽器中開啟</h2>
        <p>Google 登入不支援 LINE 內建瀏覽器</p>
        <a href="${url}" target="_blank">在瀏覽器中開啟</a>
      </body>
    </html>`);
  }

  res.redirect(url);
});
```

---

## 6. 多行事曆管理

### OAuth 後自動匯入

```javascript
// OAuth callback 中
const { allCalendars } = await googleOAuth.exchangeCode(code, state);

if (allCalendars.length > 0) {
  const user = await prisma.user.findUnique({ where: { lineUserId } });
  for (const cal of allCalendars) {
    await prisma.familyCalendar.upsert({
      where: { userId_calendarId: { userId: user.id, calendarId: cal.calendarId } },
      update: { name: cal.name },
      create: {
        userId: user.id,
        name: cal.name,
        calendarId: cal.calendarId,
        enabled: true,
        autoDiscovered: true,
      },
    });
  }
}
```

### 重新同步 API

```javascript
// POST /api/user/calendar/sync
router.post("/calendar/sync", async (req, res) => {
  const calendars = await listCalendarsForUser(req.userId);
  for (const cal of calendars) {
    await prisma.familyCalendar.upsert({
      where: { userId_calendarId: { userId: req.userId, calendarId: cal.calendarId } },
      update: { name: cal.name },
      create: { userId: req.userId, name: cal.name, calendarId: cal.calendarId, enabled: true, autoDiscovered: true },
    });
  }
  res.json({ synced: calendars.length });
});

// PUT /api/user/family-calendars/:id/toggle
router.put("/family-calendars/:id/toggle", async (req, res) => {
  const cal = await prisma.familyCalendar.findUnique({ where: { id: req.params.id } });
  if (!cal || cal.userId !== req.userId) return res.status(404).json({ error: "Not found" });
  const updated = await prisma.familyCalendar.update({
    where: { id: req.params.id },
    data: { enabled: !cal.enabled },
  });
  res.json({ calendar: updated });
});
```

### 查詢時只看啟用的行事曆

```javascript
// calendarService.js
const familyCals = await prisma.familyCalendar.findMany({
  where: { userId: dbUserId, enabled: true },  // 關鍵：只查啟用的
});
```

---

## 7. 功能模組開關系統

### 設計

```javascript
// userService.js
const DEFAULT_MODULES = ["calendar", "weather", "news", "commute", "briefing", "flight"];
const OPTIONAL_MODULES = ["nanny"];  // 需 Owner 手動開啟

async function getModules(lineUserId) {
  const user = await prisma.user.findUnique({
    where: { lineUserId },
    include: { settings: true },
  });
  const extra = JSON.parse(user?.settings?.enabledModules || "[]");
  return [...DEFAULT_MODULES, ...extra.filter(m => OPTIONAL_MODULES.includes(m))];
}

async function hasModule(lineUserId, moduleName) {
  const modules = await getModules(lineUserId);
  return modules.includes(moduleName);
}

// 僅超級管理員可設定
async function setModules(userId, modules) {
  const valid = modules.filter(m => OPTIONAL_MODULES.includes(m));
  await prisma.userSettings.update({
    where: { userId },
    data: { enabledModules: JSON.stringify(valid) },
  });
}
```

### AI 工具過濾

```javascript
// claudeAgent.js — 根據用戶模組動態過濾 AI 工具
const NANNY_TOOLS = ["calculate_nanny_salary"];

async function filterToolsForUser(lineUserId) {
  const hasNanny = await userService.hasModule(lineUserId, "nanny");
  if (hasNanny) return allTools;
  return allTools.filter(t => !NANNY_TOOLS.includes(t.name));
}
```

### API Middleware 保護

```javascript
// nannyApi.js — 模組檢查 middleware
async function requireNannyModule(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "未認證" });
  const has = await userService.hasModule(req.user.lineUserId, "nanny");
  if (!has) return res.status(403).json({ error: "此功能未開啟" });
  next();
}

router.use(requireNannyModule);
```

---

## 8. 超級管理後台

### Middleware

```javascript
// adminAuth.js
async function superAdminMiddleware(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "未認證" });
  if (req.user.lineUserId !== OWNER_LINE_USER_ID) {
    return res.status(403).json({ error: "僅限超級管理員" });
  }
  req.isSuperAdmin = true;
  next();
}
```

### 超級管理 API

```javascript
// adminApi.js
router.use(adminAuthMiddleware);
router.use(superAdminMiddleware);

// 用戶列表
router.get("/users", async (req, res) => {
  const users = await prisma.user.findMany({
    include: {
      settings: true,
      googleAuth: { select: { email: true } },
      _count: { select: { aiUsageLogs: true, conversations: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  res.json({ users });
});

// 設定用戶模組
router.put("/users/:id/modules", async (req, res) => {
  await userService.setModules(req.params.id, req.body.modules);
  res.json({ success: true });
});

// 變更用戶狀態
router.put("/users/:id/status", async (req, res) => {
  const { status } = req.body; // ACTIVE or SUSPENDED
  await prisma.user.update({
    where: { id: req.params.id },
    data: { status },
  });
  res.json({ success: true });
});

// 邀請碼 CRUD
router.get("/invitation-codes", ...);
router.post("/invitation-codes", ...);
router.delete("/invitation-codes/:code", ...);
```

### LINE Bot 入口

```javascript
// lineHandler.js
if (["超級後台", "super admin", "superadmin"].includes(text.toLowerCase())) {
  if (!await userService.isSuperAdmin(lineUserId)) {
    return replyText("此功能僅限超級管理員使用");
  }
  const token = generateAdminToken(lineUserId);
  return replyText(`超級管理後台：\n${APP_URL}/admin/super.html?token=${token}`);
}
```

---

## 9. Per-User 排程任務

### Scheduler 架構

```javascript
// schedulerService.js
function initScheduler() {
  // 每分鐘：檢查晨報 + 通勤
  cron.schedule("* * * * *", async () => {
    await checkBriefings();
    await checkCommuteNotifications();
  });

  // 每 5 分鐘：檢查行程提醒
  cron.schedule("*/5 * * * *", async () => {
    await checkEventReminders();
  });
}
```

### Per-User 晨報

```javascript
async function checkBriefings() {
  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  // 查詢所有啟用晨報且時間符合的用戶
  const configs = await prisma.briefingConfig.findMany({
    where: { enabled: true, time: currentTime },
    include: { user: { include: { settings: true, googleAuth: true } } },
  });

  for (const bc of configs) {
    if (bc.user.status !== "ACTIVE") continue;
    await triggerBriefingForUser(bc.user, bc);
  }
}

async function triggerBriefingForUser(user, briefingConfig) {
  // 用 user 的設定取得天氣、行程、新聞
  const cities = briefingConfig.cities.split(",");
  const events = user.googleAuth
    ? await calendarService.getEvents(null, today, today, user.id)
    : null;

  // 組合晨報訊息
  const text = formatBriefing(weather, events, news);

  // 只發送給這個用戶
  await lineClient.pushMessage(user.lineUserId, {
    type: "text",
    text,
  });
}
```

### Per-User 行程提醒

```javascript
async function checkEventReminders() {
  // 找出所有有行事曆的活躍用戶
  const users = await prisma.user.findMany({
    where: { status: "ACTIVE", googleAuth: { isNot: null } },
    include: { settings: true },
  });

  for (const user of users) {
    const events = await calendarService.getRawEvents(today, null, user.id);
    const reminderMin = user.settings?.eventReminderMin || 120;

    for (const event of events) {
      const minutesUntil = (eventStart - now) / 60000;
      if (minutesUntil > 0 && minutesUntil <= reminderMin) {
        // 發送提醒給該用戶
        await lineClient.pushMessage(user.lineUserId, { type: "text", text: reminder });
      }
    }
  }
}
```

---

## 10. LINE Webhook 訊息路由

### 核心流程

```javascript
// lineHandler.js
async function handleSingleEvent(event) {
  // 判斷群組 or 一對一
  const isGroup = event.source.type === "group" || event.source.type === "room";
  const chatId = isGroup
    ? (event.source.groupId || event.source.roomId)
    : event.source.userId;
  const lineUserId = event.source.userId;

  // 群組中需要 @mention 才回應
  if (isGroup) {
    const mentioned = checkMention(event);
    if (!mentioned) return; // 忽略沒有 @bot 的訊息
  }

  // 自動註冊
  if (!isGroup && lineUserId) {
    await userService.findOrCreateUser(lineUserId, profile);
  }

  // 特殊指令處理...

  // 啟用檢查
  if (!await userService.isActivated(lineUserId)) {
    return replyText("請先輸入邀請碼");
  }

  // AI 處理
  const result = await handleMessage(chatId, text);
  return replyMessage(event, result);
}
```

### 回覆訊息規則

- LINE 限制每次回覆最多 **5 則訊息**
- 文字訊息長度上限 **5000 字元**
- `replyToken` 有效期短，逾期改用 `pushMessage`

---

## 11. 環境變數清單

```env
# === LINE ===
LINE_CHANNEL_ACCESS_TOKEN=你的token
LINE_CHANNEL_SECRET=你的secret

# === 資料庫 ===
DATABASE_URL=postgresql://user:pass@host:5432/db

# === 應用程式 ===
APP_URL=https://你的域名
SESSION_SECRET=隨機字串用於JWT簽名和加密

# === Google OAuth ===
GOOGLE_OAUTH_CLIENT_ID=xxx.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-xxx

# === Owner ===
OWNER_LINE_USER_ID=U開頭的LINE用戶ID

# === AI ===
ANTHROPIC_API_KEY=sk-ant-xxx
# 或 GOOGLE_GEMINI_API_KEY=xxx
```

---

## 12. 部署檢查清單

### 首次部署

- [ ] PostgreSQL 資料庫建立
- [ ] `npx prisma db push` 同步 schema
- [ ] `npx prisma db seed` 建立 Owner + 預設邀請碼
- [ ] 環境變數全部設定
- [ ] LINE Webhook URL 設定為 `https://域名/webhook`
- [ ] Google OAuth Redirect URI 設定為 `https://域名/auth/google/callback`
- [ ] Google OAuth 同意畫面加測試用戶（測試階段）

### 新增用戶流程

1. Owner 在超級後台建立邀請碼
2. 把邀請碼給新用戶
3. 新用戶加 LINE Bot 好友
4. 新用戶輸入邀請碼 → 帳號啟用
5. 新用戶輸入「綁定行事曆」→ Google OAuth
6. Owner 在超級後台開啟該用戶需要的模組

### 多租戶隔離驗證

- [ ] 用戶 A 看不到用戶 B 的行事曆
- [ ] 用戶 A 的晨報只發給 A
- [ ] 用戶 A 的 AI 用量只算 A 的
- [ ] 停用用戶無法登入後台
- [ ] 非 Owner 無法存取超級後台 API
