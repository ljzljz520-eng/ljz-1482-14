import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireProjectMember } from "../auth/auth.middleware.js";
import { validate } from "../../lib/validate.js";
import { createReference, deleteReference, listReferences } from "./reference.service.js";

export const referenceRouter = Router();
const createSchema = z.object({
  assetId: z.number().int().positive(),
  refType: z.enum(["scene", "timeline", "article"]),
  refKey: z.string().min(1).max(128),
  label: z.string().min(1).max(128)
});

referenceRouter.post(
  "/projects/:projectId/references",
  requireAuth,
  requireProjectMember,
  validate(createSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof createSchema>;
      const ref = await createReference({
        projectId: Number(req.params.projectId),
        userId: req.userId!,
        ...body
      });
      res.status(201).json({ reference: ref });
    } catch (err) {
      next(err);
    }
  }
);

referenceRouter.get("/projects/:projectId/references", requireAuth, requireProjectMember, async (req, res, next) => {
  try {
    const assetId = req.query.assetId ? Number(req.query.assetId) : undefined;
    const refs = await listReferences(Number(req.params.projectId), assetId);
    res.json({ references: refs });
  } catch (err) {
    next(err);
  }
});

referenceRouter.delete("/projects/:projectId/references/:referenceId", requireAuth, requireProjectMember, async (req, res, next) => {
  try {
    await deleteReference(Number(req.params.projectId), Number(req.params.referenceId));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
