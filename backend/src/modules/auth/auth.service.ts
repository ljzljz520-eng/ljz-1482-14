import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { AppError, ErrorCodes } from "../../lib/errors.js";

export interface JwtPayload {
  sub: number;
  username: string;
}

export async function verifyCredentials(username: string, password: string) {
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) {
    throw new AppError(ErrorCodes.UNAUTHORIZED, "用户名或密码错误", 401);
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    throw new AppError(ErrorCodes.UNAUTHORIZED, "用户名或密码错误", 401);
  }
  return user;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, env.jwtSecret, { expiresIn: "12h" });
}

export function verifyToken(token: string): JwtPayload {
  try {
    return jwt.verify(token, env.jwtSecret) as unknown as JwtPayload;
  } catch {
    throw new AppError(ErrorCodes.UNAUTHORIZED, "登录已过期，请重新登录", 401);
  }
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}
