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
      messages: [{ type: "text", text: "目前只能理解文字訊息 📝 直接告訴我你想去哪裡吧！" }],
    });
  }

  const userId = event.source.userId;
  const text = event.message.text.trim();

  // 特殊指令
  if (["清除", "重新開始", "reset"].includes(text)) {
    clearHistory(userId);
    return lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: "text", text: "已清除對話！✨ 有什麼可以幫你的？" }],
    });
  }
  if (["幫助", "help", "說明"].includes(text)) {
    return lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [createWelcomeMessage()],
    });
  }

  // 顯示 loading（爬蟲比較慢，讓使用者知道在處理中）
  try {
    await lineClient.showLoadingAnimation({ chatId: userId, loadingSeconds: 60 });
  } catch {}

  // AI + RPA 處理
  const aiResponse = await handleMessage(userId, text);

  // 組合回覆訊息（LINE 每次最多 5 則）
  const messages = [];

  // 如果有航班資料，先送 Flex 比價卡片
  if (aiResponse.flights && aiResponse.flights.length > 0) {
    const flexMsg = createFlightComparisonFlex(aiResponse.flights);
    if (flexMsg) {
      messages.push(flexMsg);
    }
  }

  // 再送 AI 文字分析（Flex 佔 1 則，文字最多 4 則；無 Flex 則文字最多 5 則）
  const maxTextMessages = messages.length > 0 ? 4 : 5;
  const responseText = typeof aiResponse === "string" ? aiResponse : (aiResponse.text || "查詢完成");
  const textParts = splitMessage(responseText);
  textParts.slice(0, maxTextMessages).forEach((t) => {
    messages.push({ type: "text", text: t });
  });

  await lineClient.replyMessage({ replyToken: event.replyToken, messages });
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
