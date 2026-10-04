import { Router } from "express";
import { z } from "zod";
import { requireAuthQuery, requireProjectMember, requireProjectMemberQuery } from "../auth/auth.middleware.js";
import { validate } from "../../lib/validate.js";
import { eventBus } from "../../lib/events.js";
import { env } from "../../config/env.js";
import {
  deleteAsset,
  getAsset,
  listAssets,
  retryTranscode,
  streamAsset
} from "./asset.service.js";
import { processAsset } from "./transcode.service.js";

export const assetRouter = Router();
assetRouter.use(requireAuthQuery);

const listQuerySchema = z.object({
  status: z.string().optional(),
  mediaType: z.string().optional(),
  keyword: z.string().max(128).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(24)
});

assetRouter.get("/projects/:projectId/assets", requireProjectMember, async (req, res, next) => {
  try {
    const query = listQuerySchema.parse(req.query);
    const result = await listAssets({ projectId: Number(req.params.projectId), ...query });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

assetRouter.get("/projects/:projectId/assets/:assetId", requireProjectMember, async (req, res, next) => {
  try {
    const asset = await getAsset(Number(req.params.projectId), Number(req.params.assetId));
    res.json({ asset });
  } catch (err) {
    next(err);
  }
});

assetRouter.delete("/projects/:projectId/assets/:assetId", requireProjectMember, async (req, res, next) => {
  try {
    await deleteAsset(Number(req.params.projectId), Number(req.params.assetId));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

const retrySchema = z.object({ probeMode: z.enum(["sync", "async"]).default("async") });
assetRouter.post(
  "/projects/:projectId/assets/:assetId/retry",
  requireProjectMember,
  validate(retrySchema),
  async (req, res, next) => {
    try {
      const projectId = Number(req.params.projectId);
      const assetId = Number(req.params.assetId);
      const { probeMode } = req.body as z.infer<typeof retrySchema>;
      const result = await retryTranscode(projectId, assetId, probeMode);
      if (probeMode === "sync") {
        await processAsset(assetId, result.jobGeneration);
      }
      const asset = await getAsset(projectId, assetId);
      res.json({ asset, jobGeneration: result.jobGeneration });
    } catch (err) {
      next(err);
    }
  }
);

/** SSE：项目级转码/抓取进度流。前端以 jobGeneration 过滤旧代际回调。 */
assetRouter.get("/projects/:projectId/events", requireProjectMemberQuery, (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.flushHeaders?.();
  const detach = eventBus.attach(res, Number(req.params.projectId));
  req.on("close", () => {
    detach();
    // 明确释放，避免挂起连接
    res.end();
  });
});

// 媒体流：target = original | preview | cover；未就绪返回 409
assetRouter.get(
  "/projects/:projectId/assets/:assetId/stream/:target",
  requireProjectMemberQuery,
  async (req, res, next) => {
    try {
      const target = req.params.target as "original" | "preview" | "cover";
      if (!["original", "preview", "cover"].includes(target)) {
        res.status(404).end();
        return;
      }
      await streamAsset(
        Number(req.params.projectId),
        Number(req.params.assetId),
        target,
        req.headers.range,
        res
      );
    } catch (err) {
      next(err);
    }
  }
);

void env;
