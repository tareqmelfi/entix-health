# Entix Health · Vita — Git-deploy Dockerfile (Coolify pulls from GitHub; no size cap)
FROM node:20-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils tesseract-ocr tesseract-ocr-ara tesseract-ocr-eng ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install --include=dev --no-audit --no-fund
COPY . .
# Linux is case-sensitive: normalize the SPA entry to lowercase index.html for @fastify/static
RUN [ -f public/Index.html ] && [ ! -f public/index.html ] && mv public/Index.html public/index.html || true
RUN rm -rf 99-Archive src/99-Archive public/.netlify
RUN npm run build && npm prune --omit=dev
RUN mkdir -p /data/health-memory/files /data/health-memory/exports /data/health-memory/logs-redacted
ENV PORT=3030
EXPOSE 3030
CMD ["node","dist/server.js"]
