import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { childLogger } from "../../lib/logger.js";
import { processAsset } from "./transcode.service.js";

const log = childLogger("transcode-worker");

interface Job {
  assetId: number;
  generation: number;
}

class TranscodeQueue {
  private running = 0;
  private readonly pending: Job[] = [];
  private readonly inflight = new Map<number, Job>();
  private tickScheduled = false;

  enqueue(job: Job) {
    if (this.inflight.has(job.assetId)) {
      // 已在跑的旧作业不打断；其提交点会因代际不匹配丢弃结果，
      // 但还需要把新代际排上队，所以继续入 pending。
    }
    if (
      this.pending.some((j) => j.assetId === job.assetId && j.generation === job.generation)
    ) {
      return;
    }
    this.pending.push(job);
    log.info({ assetId: job.assetId, generation: job.generation, queue: this.pending.length }, "job enqueued");
    this.scheduleTick();
  }

  /** 启动时恢复：进程崩溃时处于 queued/transcoding/probing 的素材重新入队。 */
  async recover() {
    const stale = await prisma.asset.findMany({
      where: {
        deletedAt: null,
        status: { in: ["received", "previewable"] },
        stage: { in: ["queued", "probing", "transcoding"] }
      },
      select: { id: true, jobGeneration: true },
      orderBy: { id: "asc" }
    });
    for (const item of stale) {
      this.pending.push({ assetId: item.id, generation: item.jobGeneration });
    }
    log.info({ recovered: stale.length }, "transcode queue recovered");
    this.scheduleTick();
  }

  private scheduleTick() {
    if (this.tickScheduled) return;
    this.tickScheduled = true;
    queueMicrotask(() => {
      this.tickScheduled = false;
      void this.tick();
    });
  }

  private async tick() {
    while (this.running < env.workerConcurrency && this.pending.length > 0) {
      const job = this.pending.shift()!;
      // 入队后若已被更新的代际取代，跳过
      const fresh = await prisma.asset.findUnique({
        where: { id: job.assetId },
        select: { jobGeneration: true, deletedAt: true, status: true, stage: true }
      });
      if (
        !fresh ||
        fresh.deletedAt ||
        fresh.jobGeneration !== job.generation ||
        (fresh.status === "ready" && fresh.stage === "complete")
      ) {
        continue;
      }
      this.running += 1;
      this.inflight.set(job.assetId, job);
      void this.run(job);
    }
  }

  private async run(job: Job) {
    try {
      await processAsset(job.assetId, job.generation);
    } catch (err) {
      log.error({ err, assetId: job.assetId }, "unexpected worker error");
    } finally {
      this.running -= 1;
      this.inflight.delete(job.assetId);
      void this.tick();
    }
  }
}

export const transcodeQueue = new TranscodeQueue();
