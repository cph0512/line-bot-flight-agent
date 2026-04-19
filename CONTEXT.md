# CONTEXT.md — line-bot-flight-agent

AI 接續協定: 收到 `resume` → 讀此檔 → 摘要 Current State → 開工。離開前更新並 commit+push。

---

## 🎯 Current State
- **Status**: paused
- **Branch**: `main`
- **Last session**: security — replace query-string JWT with single-use nonce for OAuth bootstrap
- **Working on**: 一系列安全性強化 (OAuth/admin auth/session secret)
- **Next step**: 待使用者指示, 核心 bot 功能似已穩定
- **Blockers**: 無明確的

## 🗂 Project Overview
- **Purpose**: LINE Bot + Flight Agent — 旅遊/航班相關查詢
- **Stack**: JavaScript (Node.js), LINE Messaging API, Claude 整合 (Claude-TG timeout 3 min)
- **Key paths**: (本機未 clone, 建議 `gh repo clone line-bot-flight-agent`)
- **Entry points**: 待 clone 後確認 package.json scripts

## 🔑 Key Decisions
- **Security hardening** 多次迭代 — SESSION_SECRET mandatory, reject weak defaults, admin auth on /health /debug
- **Single-use nonce** for OAuth bootstrap (取代 query-string JWT)

## 🚧 Pending / TODO
- [ ] Clone 下來確認程式結構與 CONTEXT.md 完整度
- [ ] 待使用者給下一步方向

## 🐛 Known Issues
- 無 (近期都是安全性修復)

## 📎 External Refs
- GitHub: cph0512/line-bot-flight-agent (public)

## 🖥 Environment
- 部署位置待補 (m4pro 或 GCP?)

## 📜 Session Log
### 2026-04-19 22:30 (m4pro, claude)
- 建立 CONTEXT.md 納入 Resume Protocol (未 clone, 用 gh api 遠端寫入)
- 下次從: clone + 補完 Key paths / Entry points

### 2026-04-11 前 (近期 commits)
- bb6181f fix(security): replace query-string JWT with single-use nonce
- 221ac20 fix(security): SESSION_SECRET mandatory
- 7c84fb1 fix(security): stop accepting admin tokens via query string
- e1b4f68 fix(security): require admin auth on /health /debug/*
- 631ce05 fix: increase Claude-TG timeout to 3 minutes
