const line = require("@line/bot-sdk");
const { config } = require("../config");
const logger = require("../utils/logger");

const lineConfig = {
  channelAccessToken: config.line.channelAccessToken,
  channelSecret: config.line.channelSecret,
};

const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.line.channelAccessToken,
});

const lineMiddleware = line.middleware(lineConfig);

// 啟動時取得 bot 自身的 userId（用於群組 @mention 偵測）
let botUserId = null;
lineClient.getBotInfo().then((info) => {
  botUserId = info.userId;
  logger.info(`[LINE] Bot userId: ${botUserId}`);
}).catch((e) => {
  logger.warn(`[LINE] 無法取得 Bot Info: ${e.message}（群組 @mention 偵測可能失效）`);
});

function getBotUserId() {
  return botUserId;
}

module.exports = { lineClient, lineMiddleware, getBotUserId };
