FROM node:20-alpine
WORKDIR /app
# 无需任何 npm 依赖，纯 node:http
COPY server.mjs ./server.mjs
COPY public ./public
ENV PORT=9000
ENV HOST_HEADER=fixtures
EXPOSE 9000
CMD ["node", "server.mjs"]
