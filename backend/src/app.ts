import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { prisma } from "./db.js";
import { authPlugin } from "./routes/auth.js";
import { assetRoutes, blobRoutes } from "./routes/assets.js";
import { uploadRoutes } from "./routes/uploads.js";
import { statsRoutes } from "./routes/stats.js";

export async function buildApp(): Promise<FastifyInstance> {
  // 请求日志复用 pino（stdout 结构化），与业务 logger 同一格式
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: true,
  });

  await app.register(cors, { origin: true, exposedHeaders: ["Content-Length"] });
  // 分块上传走原始字节流（PUT chunk 直接消费 req.raw），multipart 仅用于未来扩展
  await app.register(multipart, { limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 1 } });

  // 分片上传：application/octet-stream 原样交给路由（路由消费 req.raw），
  // 不用 fastify 缓存 body，避免把大分片读进内存
  app.addContentTypeParser("application/octet-stream", (_req, _payload, done) => {
    done(null, undefined);
  });

  // 统一错误响应（不暴露堆栈，框架错误也收敛成 errorCode 结构）
  app.setErrorHandler((error, req, reply) => {
    const fstCode = (error as { code?: string }).code;
    const isFrameworkError =
      fstCode?.startsWith("FST_") ||
      ((error as { statusCode?: number }).statusCode === 400 &&
        (error as { name?: string }).name === "SyntaxError");
    if (isFrameworkError) {
      const status = (error as { statusCode?: number }).statusCode ?? 400;
      return reply.code(status).send({
        errorCode: status === 400 ? "VALIDATION" : "ERROR",
        message: error.message,
      });
    }
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err: error.message, stack: error.stack, url: req.url }, "unhandled error");
    } else {
      req.log.warn({ err: error.message, url: req.url, status }, "request rejected");
    }
    reply.code(status).send({
      errorCode:
        status === 500
          ? "INTERNAL"
          : (error as { errorCode?: string; code?: string }).errorCode ??
            (error as { code?: string }).code ??
            "ERROR",
      message: status === 500 ? "服务内部错误" : error.message,
    });
  });

  app.get("/health", async () => ({ ok: true, ts: new Date().toISOString() }));

  // 统一 /api 前缀；鉴权前置（health 除外）
  await app.register(async (api) => {
    api.addHook("preHandler", authPlugin(prisma));
    await api.register(statsRoutes, { db: prisma, prefix: "/" });
    await api.register(assetRoutes, { db: prisma, prefix: "/" });
    await api.register(blobRoutes, { db: prisma, prefix: "/" });
    await api.register(uploadRoutes, { db: prisma, prefix: "/" });
  }, { prefix: "/api" });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({
      errorCode: "NOT_FOUND",
      message: req.url.startsWith("/api") ? "接口不存在" : "资源不存在",
    });
  });

  return app;
}
