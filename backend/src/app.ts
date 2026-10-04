import express, { type ErrorRequestHandler, type Request, type Response } from "express";
import { AppError, ErrorCodes } from "./lib/errors.js";
import { childLogger } from "./lib/logger.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { projectsRouter } from "./modules/projects/projects.routes.js";
import { uploadRouter } from "./modules/uploads/upload.routes.js";
import { assetRouter } from "./modules/assets/asset.routes.js";
import { remoteRouter } from "./modules/remote/remote.routes.js";
import { statsRouter } from "./modules/stats/stats.routes.js";
import { referenceRouter } from "./modules/references/reference.routes.js";
import { parkRouter } from "./modules/park/park.routes.js";

const log = childLogger("http");

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.use((req: Request, res: Response, next) => {
    const start = Date.now();
    res.on("finish", () => {
      if (res.statusCode >= 400 || req.path === "/health") {
        log.info({ method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start });
      }
    });
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "park-media", time: new Date().toISOString() });
  });

  // 公开只读静态内容接口，置于业务鉴权路由器之前
  app.use("/park", parkRouter);

  app.use("/auth", authRouter);
  app.use("/projects", projectsRouter);
  // 各路由按路径前缀挂载，避免某个路由器上的 use() 鉴权误伤其他路径
  app.use("/", uploadRouter);
  app.use("/", assetRouter);
  app.use(remoteRouter);
  app.use(statsRouter);
  app.use(referenceRouter);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "接口不存在" } });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof AppError) {
      res.status(err.httpStatus).json({
        error: { code: err.code, message: err.message, details: err.details }
      });
      return;
    }
    if (err?.type === "entity.too.large" || err?.type === "entity.parse.failed") {
      res.status(413).json({
        error: { code: ErrorCodes.ASSET_TOO_LARGE, message: "请求体过大或格式错误" }
      });
      return;
    }
    log.error({ err: (err as Error).message, stack: (err as Error).stack }, "unhandled error");
    res.status(500).json({
      error: { code: ErrorCodes.INTERNAL, message: "服务内部错误，请稍后重试" }
    });
  };
  app.use(errorHandler);

  return app;
}
