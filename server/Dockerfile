FROM node:20-alpine AS build
WORKDIR /app
COPY server/package*.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
# ffmpeg: голосовые и кружки из браузера переводим в форматы Telegram
RUN apk add --no-cache ffmpeg
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY server/public ./public
COPY db/schema.sql ./schema.sql
# Английские версии текстов из Office: вписываются при запуске (см. src/i18nFill.ts)
COPY server/i18n-fill.json ./i18n-fill.json
CMD ["node", "dist/index.js"]
