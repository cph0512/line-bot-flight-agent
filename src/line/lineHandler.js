const { lineClient } = require("./lineClient");
const { handleMessage, clearHistory } = require("../ai/claudeAgent");
const { createWelcomeMessage, createFlightComparisonFlex } = require("./flexMessages");
const logger = require("../utils/logger");

async function handleWebhookEvents(events) {
  await Promise.allSettled(events.map((e) => handleSingleEvent(e)));
}

async function handleSingleEvent(event) {
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
  if (event.type !== "message" || event.message.type !== "text") {
    return lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: "text", text: "目前只能理解文字訊息，直接告訴我你想去哪裡吧！" }],
    });
  }

  const userId = event.source.userId;
  const text = event.message.text.trim();

  // 特殊指令
  if (["清除", "重新開始", "reset"].includes(text)) {
    clearHistory(userId);
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

  // 顯示 loading
  try {
    await lineClient.showLoadingAnimation({ chatId: userId, loadingSeconds: 60 });
  } catch {}

  logger.info(`[LINE] 開始處理訊息: userId=${userId.slice(-6)} text="${text}"`);

  let aiResponse;
  try {
    aiResponse = await handleMessage(userId, text);
  } catch (error) {
    logger.error("[LINE] AI 處理完全失敗", { error: error.message, stack: error.stack });
    aiResponse = { text: `系統錯誤：${error.message}\n\n請稍後再試，或直接到航空公司官網查詢。` };
  }

  // 組合回覆訊息（LINE 每次最多 5 則）
  const messages = [];

  // 如果有航班資料，先送 Flex 比價卡片
  if (aiResponse.flights && aiResponse.flights.length > 0) {
    try {
      const flexMsg = createFlightComparisonFlex(aiResponse.flights);
      if (flexMsg) {
        messages.push(flexMsg);
        logger.info(`[LINE] 已建立 Flex Message: ${aiResponse.flights.length} 筆航班`);
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
    // replyToken 過期的話可以試用 push message（需要額外付費）
    try {
      await lineClient.pushMessage({
        to: userId,
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
