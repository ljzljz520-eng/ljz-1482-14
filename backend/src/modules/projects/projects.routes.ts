import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../auth/auth.middleware.js";

export const projectsRouter = Router();

projectsRouter.get("", requireAuth, async (_req, res) => {
  const projects = await prisma.projectMember.findMany({
    where: { userId: _req.userId },
    include: { project: true },
    orderBy: { projectId: "asc" }
  });
  res.json({
    projects: projects.map((m) => ({
      id: m.project.id,
      key: m.project.key,
      name: m.project.name,
      role: m.role
    }))
  });
});
