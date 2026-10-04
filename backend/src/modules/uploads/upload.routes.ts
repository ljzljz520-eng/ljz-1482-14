import { Router, raw } from "express";
import { z } from "zod";
import { validate } from "../../lib/validate.js";
import { requireAuth, requireProjectMember } from "../auth/auth.middleware.js";
import {
  abortSession,
  completeSession,
  createSession,
  getSession,
  putChunk
} from "./upload.service.js";
import { processAsset } from "../assets/transcode.service.js";

export const uploadRouter = Router();

const CHUNK_LIMIT = "16mb";

const createSchema = z.object({
  clientToken: z.string().min(8).max(128),
  filename: z.string().min(1).max(255),
  declaredSize: z.number().int().positive(),
  chunkSize: z.number().int().min(256 * 1024),
  sha256Expected: z.string().regex(/^[a-f0-9]{64}$/i).nullable().optional(),
  contentType: z.string().max(128).nullable().optional()
});

// 创建会话（幂等：中断恢复时同 token 返回已收块范围）
uploadRouter.post(
  "/projects/:projectId/sessions",
  requireAuth,
  requireProjectMember,
  validate(createSchema),
  async (req, res, next) => {
    try {
      const projectId = Number(req.params.projectId);
      const body = req.body as z.infer<typeof createSchema>;
      const session = await createSession({
        projectId,
        userId: req.userId!,
        clientToken: body.clientToken,
        filename: body.filename,
        declaredSize: body.declaredSize,
        chunkSize: body.chunkSize,
        sha256Expected: body.sha256Expected,
        contentType: body.contentType
      });
      res.status(201).json({ session });
    } catch (err) {
      next(err);
    }
  }
);

uploadRouter.get("/projects/:projectId/sessions/:sessionId", requireAuth, requireProjectMember, async (req, res, next) => {
  try {
    const session = await getSession(Number(req.params.projectId), Number(req.params.sessionId));
    res.json({ session });
  } catch (err) {
    next(err);
  }
});

// 写入分片：raw 二进制，校验值走 X-Chunk-Sha256
uploadRouter.put(
  "/projects/:projectId/sessions/:sessionId/chunks/:index",
  requireAuth,
  requireProjectMember,
  raw({ type: () => true, limit: CHUNK_LIMIT }),
  async (req, res, next) => {
    try {
      const checksum = String(req.headers["x-chunk-sha256"] ?? "").toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(checksum)) {
        res.status(422).json({
          error: {
            code: "VALIDATION_ERROR",
            message: "缺少或非法的 X-Chunk-Sha256 头（需 64 位十六进制 SHA256）"
          }
        });
        return;
      }
      const session = await putChunk({
        projectId: Number(req.params.projectId),
        sessionId: Number(req.params.sessionId),
        index: Number(req.params.index),
        body: req.body as Buffer,
        checksum
      });
      res.json({ session });
    } catch (err) {
      next(err);
    }
  }
);

const completeSchema = z.object({
  probeMode: z.enum(["sync", "async"]).default("async")
});

// 完成上传（幂等：重试不创建重复素材）
uploadRouter.post(
  "/projects/:projectId/sessions/:sessionId/complete",
  requireAuth,
  requireProjectMember,
  validate(completeSchema),
  async (req, res, next) => {
    try {
      const projectId = Number(req.params.projectId);
      const sessionId = Number(req.params.sessionId);
      const { probeMode } = req.body as z.infer<typeof completeSchema>;
      const result = await completeSession({ projectId, userId: req.userId!, sessionId, probeMode });

      // 同步探测：请求内直接完成转码，响应即“完整可用/失败”，前端拿到终态
      if (probeMode === "sync" && !result.alreadyExisted && result.asset.status !== "ready") {
        await processAsset(result.asset.id, result.asset.jobGeneration);
      }
      const { getAsset } = await import("../assets/asset.service.js");
      const asset = await getAsset(projectId, result.asset.id);
      res.status(result.alreadyExisted ? 200 : 201).json({
        asset,
        alreadyExisted: result.alreadyExisted,
        probeMode
      });
    } catch (err) {
      next(err);
    }
  }
);

uploadRouter.delete("/projects/:projectId/sessions/:sessionId", requireAuth, requireProjectMember, async (req, res, next) => {
  try {
    await abortSession(Number(req.params.projectId), Number(req.params.sessionId));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
