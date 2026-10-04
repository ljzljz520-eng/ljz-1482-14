import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import { requireProject } from "./auth.js";
import { BLOB_DIR } from "../services/blobStore.js";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** 占用情况：项目逻辑占用（按引用去重前的素材体积）与物理占用（去重后真实落盘） */
export async function statsRoutes(app: FastifyInstance, opts: { db: Db }) {
  const db = opts.db;

  app.get("/stats", async (req) => {
    const project = requireProject(req);

    const grouped = await db.asset.groupBy({
      by: ["status"],
      where: { projectId: project.id },
      _count: { _all: true },
    });
    const byStatus = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));

    // 项目逻辑占用：该项目所有源素材大小之和
    const sourceAssets = await db.asset.findMany({
      where: { projectId: project.id },
      select: { size: true, sourceBlobId: true },
    });
    const logicalBytes = sourceAssets.reduce((acc, a) => acc + Number(a.size), 0);

    // 去重后项目相关的唯一源 blob 集合（项目内去重节省）
    const uniqueSourceBlobs = new Set(sourceAssets.map((a) => a.sourceBlobId));
    const uniqueSourceBytes = (
      await db.blobObject.findMany({
        where: { id: { in: [...uniqueSourceBlobs] } },
        select: { size: true },
      })
    ).reduce((acc, b) => acc + Number(b.size), 0);

    // 派生件占用（项目内唯一 blob）
    const derivBlobs = await db.derivative.findMany({
      where: { asset: { projectId: project.id } },
      select: { blobId: true, size: true },
    });
    const uniqueDerivBlobs = new Set(derivBlobs.map((d) => d.blobId));
    const derivBytes = (
      await db.blobObject.findMany({
        where: { id: { in: [...uniqueDerivBlobs] } },
        select: { size: true },
      })
    ).reduce((acc, b) => acc + Number(b.size), 0);

    // 全局物理占用（磁盘上全部 blob，跨项目共享字节）
    let physicalBytes = 0;
    try {
      for (const bucket of readdirSync(BLOB_DIR)) {
        for (const f of readdirSync(join(BLOB_DIR, bucket))) {
          physicalBytes += statSync(join(BLOB_DIR, bucket, f)).size;
        }
      }
    } catch {
      /* storage 尚未初始化时忽略 */
    }

    const jobsRunning = await db.job.count({ where: { status: { in: ["QUEUED", "RUNNING"] }, asset: { projectId: project.id } } });

    return {
      project: { id: project.id, name: project.name, code: project.code, quotaBytes: Number(project.quotaBytes) },
      assets: {
        total: sourceAssets.length,
        received: byStatus["RECEIVED"] ?? 0,
        previewable: byStatus["PREVIEWABLE"] ?? 0,
        ready: byStatus["READY"] ?? 0,
        failed: byStatus["FAILED"] ?? 0,
        unknown: byStatus["unknown"] ?? 0,
      },
      jobsRunning,
      bytes: {
        logical: logicalBytes, // 素材逻辑体积（重复上传也计数）
        uniqueSource: uniqueSourceBytes, // 项目内去重后源字节
        derivatives: derivBytes,
        physicalGlobal: physicalBytes, // 磁盘真实占用（全局内容去重）
        quota: Number(project.quotaBytes),
      },
      savings: {
        inProjectDedupBytes: Math.max(0, logicalBytes - uniqueSourceBytes),
      },
    };
  });

  app.get("/me", async (req) => {
    const project = requireProject(req);
    return { project: { id: project.id, code: project.code, name: project.name } };
  });
}
