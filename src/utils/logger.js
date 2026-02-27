const winston = require("winston");
const logger = winston.createLogger({
  level: process.env.NODE_ENV === "development" ? "debug" : "info",
  format: winston.format.combine(
    winston.format.timestamp({ format: "HH:mm:ss" }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const m = Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
      return `[${timestamp}] ${level.toUpperCase()}: ${message}${m}`;
    })
  ),
  transports: [new winston.transports.Console()],
});
module.exports = logger;
