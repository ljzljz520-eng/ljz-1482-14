import type { NextFunction, Request, Response } from "express";
import { prisma } from "../../lib/prisma.js";
import { AppError, ErrorCodes } from "../../lib/errors.js";
import { verifyToken } from "./auth.service.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: number;
      username?: string;
    }
  }
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new AppError(ErrorCodes.UNAUTHORIZED, "缺少登录凭证", 401);
    }
    const payload = verifyToken(header.slice(7));
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) throw new AppError(ErrorCodes.UNAUTHORIZED, "用户不存在", 401);
    req.userId = user.id;
    req.username = user.username;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * 项目级授权守卫：成员才可访问该项目素材。
 * 字节内容虽按 sha256 去重复用，授权与项目归属始终按 Asset 独立判定，不随去重共享。
 */
export async function requireProjectMember(req: Request, _res: Response, next: NextFunction) {
  try {
    const projectId = Number(req.params.projectId);
    if (!Number.isInteger(projectId)) {
      throw new AppError(ErrorCodes.VALIDATION, "项目 ID 不合法", 422);
    }
    const membership = await prisma.projectMember.findUnique({
      where: { userId_projectId: { userId: req.userId!, projectId } }
    });
    if (!membership) {
      throw new AppError(ErrorCodes.FORBIDDEN, "你没有该项目的访问权限", 403);
    }
    (req as unknown as { projectRole: string }).projectRole = membership.role;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireProjectRole(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const role = (req as unknown as { projectRole?: string }).projectRole;
    if (!role || !roles.includes(role)) {
      next(new AppError(ErrorCodes.FORBIDDEN, "当前角色无权执行该操作", 403));
      return;
    }
    next();
  };
}


/**
 * 只读媒体流 / SSE 无法通过浏览器原生 API（<video>/EventSource）携带 Authorization 头，
 * 允许以 ?token= 传入 JWT。这些端点仅做读操作且受项目成员校验；
 * 写接口（上传/删除/抓取）一律只接受 Authorization 头，不接受查询参数令牌。
 */
export async function requireAuthQuery(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    const queryToken = typeof req.query.token === "string" ? req.query.token : null;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : queryToken;
    if (!token) throw new AppError(ErrorCodes.UNAUTHORIZED, "缺少登录凭证", 401);
    const payload = verifyToken(token);
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) throw new AppError(ErrorCodes.UNAUTHORIZED, "用户不存在", 401);
    req.userId = user.id;
    req.username = user.username;
    next();
  } catch (err) {
    next(err);
  }
}

/** 与 requireProjectMember 相同，但通常搭配 requireAuthQuery 用于只读流。 */
export const requireProjectMemberQuery = requireProjectMember;
