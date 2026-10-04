import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { validate } from "../../lib/validate.js";
import { signToken, verifyCredentials } from "./auth.service.js";
import { requireAuth } from "./auth.middleware.js";

export const authRouter = Router();

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(128)
});

authRouter.post("/login", validate(loginSchema), async (req, res, next) => {
  try {
    const { username, password } = req.body as z.infer<typeof loginSchema>;
    const user = await verifyCredentials(username, password);
    const token = signToken({ sub: user.id, username: user.username });
    res.json({
      token,
      user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role }
    });
  } catch (err) {
    next(err);
  }
});

authRouter.get("/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { id: true, username: true, displayName: true, role: true, memberships: true }
  });
  res.json({ user });
});
