import { Router } from "express";
import { requireAuth, requireProjectMember } from "../auth/auth.middleware.js";
import { projectStats } from "./stats.service.js";

export const statsRouter = Router();
statsRouter.get("/projects/:projectId/stats", requireAuth, requireProjectMember, async (req, res, next) => {
  try {
    const stats = await projectStats(Number(req.params.projectId));
    res.json({ stats });
  } catch (err) {
    next(err);
  }
});
