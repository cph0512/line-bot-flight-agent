FROM node:18-slim

# 設定 Playwright 瀏覽器安裝路徑
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0

# Playwright Chromium 需要的系統依賴（含 CJK 字型）
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libatspi2.0-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libwayland-client0 \
    fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先安裝 dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# 安裝 Playwright Chromium（含依賴檢查）
RUN npx playwright install --with-deps chromium

# 複製程式碼
COPY . .

# 建立截圖目錄
RUN mkdir -p screenshots

EXPOSE 3000

CMD ["node", "src/index.js"]
