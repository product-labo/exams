# Production image: backend + the static web pages in one container (used by docker compose and Render).
FROM node:22-alpine
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev
COPY backend/src ./src
COPY backend/sql ./sql
COPY public ./public
ENV NODE_ENV=production OCR_CACHE_DIR=/tmp/ocr-cache
EXPOSE 3000
CMD ["node", "src/index.js"]
