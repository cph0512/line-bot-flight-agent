const line = require("@line/bot-sdk");
const { config } = require("../config");

const lineConfig = {
  channelAccessToken: config.line.channelAccessToken,
  channelSecret: config.line.channelSecret,
};

const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.line.channelAccessToken,
});

const lineMiddleware = line.middleware(lineConfig);

module.exports = { lineClient, lineMiddleware };
