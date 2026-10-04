# ---- 构建阶段 ----
FROM node:20-bookworm-slim AS builder
WORKDIR /app
RUN npm config set registry https://registry.npmmirror.com
COPY package*.json ./
RUN npm install
COPY prisma ./prisma
# 构建期仅需一个合法格式的 DATABASE_URL 来生成客户端；真实连接在运行时注入
ENV DATABASE_URL="mysql://park:park@db:3306/park_media"
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- 生产阶段：bookworm-slim 可直接 apt 安装 ffmpeg/ffprobe ----
FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
# ffmpeg 提供转码/探测（含 ffprobe）；ca-certificates 供 https 抓取
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# 完整 node_modules（含 prisma CLI 与 MySQL query engine）
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY package*.json ./
COPY docker/entrypoint.sh ./docker/entrypoint.sh
RUN chmod +x ./docker/entrypoint.sh \
  && mkdir -p /app/data
EXPOSE 8080
CMD ["./docker/entrypoint.sh"]
