const { lineClient, getBotUserId } = require("./lineClient");
const { handleMessage, clearHistory } = require("../ai/claudeAgent");
const { createWelcomeMessage, createFlightComparisonFlex } = require("./flexMessages");
const { config } = require("../config");
const userService = require("../services/userService");
const { generateAdminToken } = require("../auth/adminAuth");
const { isDbAvailable } = require("../db/prisma");
const logger = require("../utils/logger");

// 邀請碼格式：6-20 字元英數字
const INVITATION_CODE_REGEX = /^[A-Z0-9]{6,20}$/i;

async function handleWebhookEvents(events) {
  await Promise.allSettled(events.map((e) => handleSingleEvent(e)));
}

async function handleSingleEvent(event) {
  // === 群組 / 1 對 1 偵測 ===
  const isGroup = event.source.type === "group" || event.source.type === "room";
  const chatId = isGroup
    ? (event.source.groupId || event.source.roomId)
    : event.source.userId;

  // --- follow / unfollow / leave ---
  if (event.type === "follow") {
    return lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [createWelcomeMessage()],
    });
  }
  if (event.type === "unfollow") {
    clearHistory(event.source.userId);
    return;
  }
  if (event.type === "leave") {
    // 群組踢出 bot 時清除該群組的對話記錄
    logger.info(`[LINE] Bot 被移出群組 ${chatId}`);
    clearHistory(chatId);
    return;
  }
  // 加入群組時打招呼
  if (event.type === "join") {
    return lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: "text", text: "大家好！我是全能家庭 AI 管家 🏠✨\n\n在群組中請 @我 來使用功能喔！\n例如：@管家 台北天氣" }],
    });
  }

  // --- 只處理文字訊息 ---
  if (event.type !== "message" || event.message.type !== "text") {
    // 群組中非文字訊息直接忽略（不回覆）
    if (isGroup) return;
    return lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: "text", text: "目前只能理解文字訊息，直接告訴我你想去哪裡吧！" }],
    });
  }

  let text = event.message.text.trim();

  // === 群組 @mention 過濾 ===
  if (isGroup) {
    const botId = getBotUserId();
    const mentionees = event.message.mention?.mentionees || [];
    const isMentioned = mentionees.some((m) => m.userId === botId);

    // 特殊指令不需要 @mention（我的id、幫助）
    const isSpecialCommand = ["我的id", "我的ID", "myid", "my id", "userid", "幫助", "help", "說明"]
      .includes(text.toLowerCase());

    if (!isMentioned && !isSpecialCommand) {
      // 群組中沒有 @bot，忽略
      return;
    }

    // 從文字中移除 @mention 部分
    if (isMentioned && mentionees.length > 0) {
      // 按 index 由大到小排序，從後面開始移除，避免 index 偏移
      const botMentions = mentionees
        .filter((m) => m.userId === botId)
        .sort((a, b) => b.index - a.index);
      for (const m of botMentions) {
        text = text.slice(0, m.index) + text.slice(m.index + m.length);
      }
      text = text.trim();
    }

    // 移除 @mention 後如果是空的，給個提示
    if (!text) {
      return lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: "text", text: "有什麼可以幫你的嗎？😊\n\n試試：「台北天氣」「查機票」「新聞」「晨報」" }],
      });
    }

    logger.info(`[LINE] 群組訊息: chatId=${chatId.slice(-6)} @mentioned text="${text}"`);
  }

  // === 用戶自動註冊（多租戶模式）===
  const lineUserId = event.source.userId;
  if (isDbAvailable() && lineUserId && !isGroup) {
    try {
      let profile = {};
      try {
        profile = await lineClient.getProfile(lineUserId);
      } catch {}
      await userService.findOrCreateUser(lineUserId, profile);
    } catch (e) {
      logger.warn(`[LINE] 用戶註冊失敗: ${e.message}`);
    }
  }

  // === 特殊指令 ===
  if (["清除", "重新開始", "reset"].includes(text)) {
    clearHistory(chatId);
    return lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: "text", text: "已清除對話！有什麼可以幫你的？" }],
    });
  }
  if (["幫助", "help", "說明"].includes(text)) {
    return lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [createWelcomeMessage()],
    });
  }
  if (["我的id", "我的ID", "myid", "my id", "userid"].includes(text.toLowerCase())) {
    const idText = isGroup
      ? `群組 ID：\n${chatId}\n\n可用於 BRIEFING_RECIPIENTS 環境變數，讓晨報推送到此群組。`
      : `你的 LINE User ID：\n${chatId}\n\n請複製此 ID 貼到 Railway 的 BRIEFING_RECIPIENTS 環境變數。`;
    return lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: "text", text: idText }],
    });
  }

  // === 後台管理連結 ===
  if (!isGroup && ["後台", "管理", "admin", "設定"].includes(text.toLowerCase())) {
    if (isDbAvailable() && lineUserId) {
      const activated = await userService.isActivated(lineUserId);
      if (activated) {
        const token = generateAdminToken(lineUserId);
        const adminUrl = `${config.app.url}/admin?token=${token}`;
        return lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: "text", text: `你的後台管理連結（24小時有效）：\n\n${adminUrl}` }],
        });
      }
    }
    // Fallback: 舊模式
    return lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: "text", text: `後台管理：\n${config.app.url}/admin` }],
    });
  }

  // === 邀請碼啟用 ===
  if (!isGroup && isDbAvailable() && lineUserId && INVITATION_CODE_REGEX.test(text)) {
    const user = await userService.getUserByLineId(lineUserId);
    if (user && user.status === "PENDING") {
      const result = await userService.activateUser(lineUserId, text);
      return lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: "text", text: result.message }],
      });
    }
  }

  // === 綁定行事曆 ===
  if (!isGroup && ["綁定行事曆", "連結行事曆", "link calendar"].includes(text.toLowerCase())) {
    try {
      const { isAvailable, generateAuthUrl } = require("../auth/googleOAuth");
      if (isAvailable() && lineUserId) {
        const authUrl = generateAuthUrl(lineUserId);
        return lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: "text", text: `請點擊以下連結來綁定你的 Google 行事曆：\n\n${authUrl}` }],
        });
      }
    } catch (e) {
      logger.warn(`[LINE] OAuth URL 產生失敗: ${e.message}`);
    }
    return lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: "text", text: "行事曆綁定功能尚未啟用，請聯繫管理員。" }],
    });
  }

  // === 功能閘門：未啟用用戶提示 ===
  if (!isGroup && isDbAvailable() && lineUserId) {
    const activated = await userService.isActivated(lineUserId);
    if (!activated) {
      // 未啟用用戶只能基本對話，工具功能受限
      // 先檢查是否觸發了需要工具的功能
      const toolKeywords = ["天氣", "新聞", "行事曆", "行程", "機票", "航班", "薪水", "保母", "路況", "晨報"];
      const needsTool = toolKeywords.some((k) => text.includes(k));
      if (needsTool) {
        return lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: "text", text: "你需要輸入邀請碼來啟用完整功能。\n\n請輸入你的邀請碼（例如：FAMILY2026）" }],
        });
      }
    }
  }

  // === 顯示 loading ===
  try {
    await lineClient.showLoadingAnimation({ chatId, loadingSeconds: 60 });
  } catch {}

  logger.info(`[LINE] 開始處理訊息: chatId=${chatId.slice(-6)} isGroup=${isGroup} text="${text}"`);

  // === AI 處理 ===
  let aiResponse;
  try {
    aiResponse = await handleMessage(chatId, text);
  } catch (error) {
    logger.error("[LINE] AI 處理完全失敗", { error: error.message, stack: error.stack });
    aiResponse = { text: `系統錯誤：${error.message}\n\n請稍後再試，或直接到航空公司官網查詢。` };
  }

  // === 組合回覆訊息（LINE 每次最多 5 則）===
  const messages = [];

  // 如果有航班資料，先送 Flex 比價卡片（去程 + 回程）
  if (aiResponse.flights && aiResponse.flights.length > 0) {
    try {
      const inbound = aiResponse.inboundFlights || [];
      const flexMsg = createFlightComparisonFlex(aiResponse.flights, inbound);
      if (flexMsg) {
        messages.push(flexMsg);
        logger.info(`[LINE] 已建立 Flex Message: 去程=${aiResponse.flights.length} 回程=${inbound.length}`);
      }
    } catch (flexErr) {
      logger.error("[LINE] Flex Message 建立失敗", { error: flexErr.message });
    }
  }

  // 再送 AI 文字分析
  const maxTextMessages = messages.length > 0 ? 4 : 5;
  const responseText = typeof aiResponse === "string"
    ? aiResponse
    : (aiResponse.text || "查詢完成");
  const textParts = splitMessage(responseText);
  textParts.slice(0, maxTextMessages).forEach((t) => {
    messages.push({ type: "text", text: t });
  });

  // 確保至少有一則訊息
  if (messages.length === 0) {
    messages.push({ type: "text", text: "查詢完成，但沒有找到結果。" });
  }

  try {
    await lineClient.replyMessage({ replyToken: event.replyToken, messages });
    logger.info(`[LINE] 回覆成功: ${messages.length} 則訊息`);
  } catch (replyErr) {
    logger.error("[LINE] replyMessage 失敗（replyToken 可能已過期）", {
      error: replyErr.message,
    });
    // replyToken 過期的話可以試用 push message
    try {
      await lineClient.pushMessage({
        to: chatId,
        messages: messages.slice(0, 5),
      });
      logger.info("[LINE] 改用 pushMessage 成功");
    } catch (pushErr) {
      logger.error("[LINE] pushMessage 也失敗", { error: pushErr.message });
    }
  }
}

function splitMessage(text, max = 4500) {
  if (text.length <= max) return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= max) { parts.push(remaining); break; }
    let i = remaining.lastIndexOf("\n", max);
    if (i < max * 0.5) i = max;
    parts.push(remaining.slice(0, i));
    remaining = remaining.slice(i).trim();
  }
  return parts;
}

module.exports = { handleWebhookEvents };
