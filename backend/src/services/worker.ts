import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import type { Db } from "../db.js";
import { logger } from "../logger.js";
import { processAsset } from "./transcodeService.js";

const POLL_INTERVAL_MS = 500;
const LOCK_TTL_MS = 60_000;

export class TranscodeWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private workerId = randomUUID();

  constructor(private db: Db) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((e) => logger.error({ err: String(e) }, "worker tick error")), POLL_INTERVAL_MS);
    logger.info({ workerId: this.workerId }, "transcode worker started");
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async claimQueued() {
    return this.db.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw`
          SELECT id, "assetId" FROM "Job"
          WHERE status = 'QUEUED'
          ORDER BY "queuedAt" ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `;
        if (!Array.isArray(rows) || rows.length === 0) return null;
        const row = rows[0] as { id: string; assetId: string | null };
        await tx.job.update({
          where: { id: row.id },
          data: {
            status: "RUNNING",
            startedAt: new Date(),
            attempt: { increment: 1 },
            lockedBy: this.workerId,
            lockedUntil: new Date(Date.now() + LOCK_TTL_MS),
          },
        });
        return row;
      },
      { timeout: 10_000 }
    );
  }

  /** 接管本实例之前遗留在 RUNNING 但锁已过期的任务（崩溃恢复） */
  private async reclaimStale() {
    const stale = await this.db.job.findFirst({
      where: { status: "RUNNING", lockedUntil: { lt: new Date() } },
      orderBy: { queuedAt: "asc" },
    });
    return stale;
  }

  private async runJob(job: { id: string; assetId: string | null }) {
    if (!job.assetId) return;
    const asset = await this.db.asset.findUnique({ where: { id: job.assetId } });
    if (!asset) {
      // 删除素材时转码恰好完成/排队：任务取消，不产生孤儿素材
      await this.db.job.updateMany({
        where: { id: job.id },
        data: { status: "CANCELLED", finishedAt: new Date(), lastError: "asset deleted before run" },
      });
      return;
    }
    logger.info({ jobId: job.id, assetId: job.assetId }, "picked transcode job");
    await processAsset(this.db, job.assetId, "async", { jobId: job.id });
  }

  /** 测试/同步路径可直接调用一次循环（处理一个任务；RUNNING 中任务由 inFlight 复用） */
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const job = (await this.claimQueued()) ?? (await this.reclaimStale());
      if (!job) return;
      this.inFlight = this.runJob({ id: job.id, assetId: job.assetId }).catch((e: unknown) =>
        logger.error({ err: String(e) }, "job execution error")
      );
      await this.inFlight;
      this.inFlight = null;
    } finally {
      this.running = false;
    }
  }

  private inFlight: Promise<void> | null = null;

  /** 测试辅助：等待所有任务离开 QUEUED/RUNNING */
  async drain(maxWaitMs = 60_000) {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const pending = await this.db.job.count({ where: { status: { in: ["QUEUED", "RUNNING"] } } });
      if (pending === 0) return;
      await this.tick();
      if (this.inFlight) await this.inFlight.catch(() => undefined);
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("worker drain timeout");
  }
}

export function startWorkerIfEnabled(db: Db): TranscodeWorker | null {
  if (!config.WORKER_ENABLED) {
    logger.info("transcode worker disabled (WORKER_ENABLED=false)");
    return null;
  }
  const w = new TranscodeWorker(db);
  w.start();
  return w;
}
