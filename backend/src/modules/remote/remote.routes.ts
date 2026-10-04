import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireProjectMember } from "../auth/auth.middleware.js";
import { validate } from "../../lib/validate.js";
import { createFetch, listFetches } from "./remote.service.js";
import { processAsset } from "../assets/transcode.service.js";
import { getAsset } from "../assets/asset.service.js";

export const remoteRouter = Router();
const fetchSchema = z.object({
  url: z.string().url().max(2048),
  probeMode: z.enum(["sync", "async"]).default("async")
});

remoteRouter.post(
  "/projects/:projectId/remote-fetches",
  requireAuth,
  requireProjectMember,
  validate(fetchSchema),
  async (req, res, next) => {
    try {
      const projectId = Number(req.params.projectId);
      const { url, probeMode } = req.body as z.infer<typeof fetchSchema>;
      const result = await createFetch({ projectId, userId: req.userId!, url, probeMode });
      // 同步探测：请求内直接转码到终态；异步：由 worker 队列完成
      if (probeMode === "sync") {
        await processAsset(result.assetId, 0);
      }
      const asset = await getAsset(projectId, result.assetId);
      res.status(202).json({ fetch: result.fetch, asset, probeMode });
    } catch (err) {
      next(err);
    }
  }
);

remoteRouter.get("/projects/:projectId/remote-fetches", requireAuth, requireProjectMember, async (req, res, next) => {
  try {
    const limit = Math.min(100, Number(req.query.limit as string) || 30);
    const jobs = await listFetches(Number(req.params.projectId), limit);
    res.json({ fetches: jobs });
  } catch (err) {
    next(err);
  }
});
