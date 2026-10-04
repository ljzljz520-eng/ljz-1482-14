import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db.js";

declare module "fastify" {
  interface FastifyRequest {
    project?: { id: string; code: string; name: string; quotaBytes: bigint };
    tokenId?: string;
  }
}

/**
 * Bearer Token 鉴权：token 决定项目身份。
 * 内容去重只共享字节，项目归属与授权永远隔离：每个查询都带 projectId。
 */
export function authPlugin(db: Db) {
  return async (req: FastifyRequest, reply: ReplyLike) => {
    if (req.url.startsWith("/health") || req.url.startsWith("/public")) return;
    const header = req.headers.authorization ?? "";
    const match = /^Bearer\s+(.+)$/.exec(header);
    if (!match) {
      return reply.code(401).send({ errorCode: "UNAUTHORIZED", message: "缺少 Authorization: Bearer <token>" });
    }
    const token = match[1].trim();
    const record = await db.apiToken.findUnique({
      where: { token },
      include: { project: true },
    });
    if (!record) {
      return reply.code(401).send({ errorCode: "UNAUTHORIZED", message: "无效的访问令牌" });
    }
    req.tokenId = record.id;
    req.project = {
      id: record.project.id,
      code: record.project.code,
      name: record.project.name,
      quotaBytes: record.project.quotaBytes,
    };
    // 记录最后使用时间（不阻塞请求）
    db.apiToken
      .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);
  };
}

interface ReplyLike {
  code(code: number): { send(payload: unknown): void };
}

export function requireProject(req: FastifyRequest) {
  if (!req.project) {
    const err = new Error("unauthorized") as Error & { statusCode?: number };
    err.statusCode = 401;
    throw err;
  }
  return req.project;
}

export type AuthedRequest = FastifyRequest & {
  project: { id: string; code: string; name: string; quotaBytes: bigint };
  tokenId: string;
};

export type { FastifyReply };
