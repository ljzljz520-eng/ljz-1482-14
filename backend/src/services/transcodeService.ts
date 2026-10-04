import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Db } from "../db.js";
import { logger } from "../logger.js";
import {
  ProbeError,
  cleanupFile,
  probe,
  transcodeAudioPreview,
  transcodeImageThumbnail,
  transcodeThumbnail,
  transcodeVideoPreview,
  transcodeWaveform,
  type ProbeResult,
} from "./media.js";
import { blobPath, commitLocalFile } from "./blobStore.js";
import { registerDerivative } from "./assetService.js";

export type ProbeMode = "sync" | "async";

export type FinalStatus = "RECEIVED" | "PREVIEWABLE" | "READY" | "FAILED";

export interface ProcessOutcome {
  mode: ProbeMode;
  finalStatus: FinalStatus;
  probeMs: number | null;
  probe: ProbeResult | null;
  warnings: string[];
  deferredToAsync?: boolean;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * 阶段一：探测（可同步、可异步）。
 * - sync：在 HTTP 请求预算（SYNC_PROBE_MS）内跑完 ffprobe，立即拿到元数据；
 * - async：由 worker 无超时压力地探测。
 * 两种模式探测结果都写入同一张表、驱动同一状态机。
 */
export async function probeAndPersist(
  db: Db,
  assetId: string,
  mode: ProbeMode,
  timeoutMs?: number,
  signal?: AbortSignal
): Promise<
  | { ok: true; meta: ProbeResult; probeMs: number; warnings: string[] }
  | { ok: false; timeout: true }
  | { ok: false; timeout: false; errorCode: string; errorMessage: string; probeMs: number }
> {
  const asset = await db.asset.findUnique({ include: { sourceBlob: true }, where: { id: assetId } });
  if (!asset) return { ok: false, timeout: false, errorCode: "ASSET_GONE", errorMessage: "素材不存在", probeMs: 0 };

  // 同步路径已经探测过：异步阶段直接复用，不重复探测
  if (asset.kind !== "unknown") {
    return {
      ok: true,
      meta: {
        kind: asset.kind as ProbeResult["kind"],
        durationMs: asset.durationMs,
        width: asset.width,
        height: asset.height,
        hasVideo: asset.hasVideo,
        hasAudio: asset.hasAudio,
        codecVideo: null,
        codecAudio: null,
        formatName: null,
        mimeType: asset.mimeType,
      },
      probeMs: asset.probeMs ?? 0,
      warnings: asset.errorCode === "NO_AUDIO_STREAM" ? ["NO_AUDIO_STREAM"] : [],
    };
  }

  const sourceLocal = blobPath(asset.sourceBlob.sha256);
  const t0 = performance.now();
  let meta: ProbeResult;
  try {
    meta = await probe(sourceLocal, timeoutMs, signal);
  } catch (err) {
    const probeMs = Math.round(performance.now() - t0);
    if (err instanceof ProbeError && err.code === "PROBE_TIMEOUT") {
      // 同步预算内没探完：标记由异步接管，不判失败——原件仍处于 RECEIVED
      return { ok: false, timeout: true };
    }
    const code = err instanceof ProbeError ? err.code : "PROBE_FAILED";
    await db.asset.update({
      where: { id: assetId },
      data: { status: "FAILED", errorCode: code, errorMessage: (err as Error).message, probeMode: mode, probeMs },
    });
    return { ok: false, timeout: false, errorCode: code, errorMessage: (err as Error).message, probeMs };
  }
  const probeMs = Math.round(performance.now() - t0);
  const warnings: string[] = [];
  if (meta.kind === "video" && !meta.hasAudio) warnings.push("NO_AUDIO_STREAM");

  await db.asset.update({
    where: { id: assetId },
    data: {
      kind: meta.kind,
      width: meta.width,
      height: meta.height,
      durationMs: meta.durationMs,
      hasVideo: meta.hasVideo,
      hasAudio: meta.hasAudio,
      probeMode: mode,
      probeMs,
      errorCode: warnings.includes("NO_AUDIO_STREAM") ? "NO_AUDIO_STREAM" : null,
      errorMessage: warnings.includes("NO_AUDIO_STREAM") ? "该视频不含音轨" : null,
    },
  });
  return { ok: true, meta, probeMs, warnings };
}

/**
 * 统一的素材处理管线（异步 worker 主路径；小图同步路径也复用）：
 * RECEIVED（原件已收）→ 探测元数据 → 首批派生件(PREVIEWABLE) → 全部派生件(READY) / FAILED
 */
export async function processAsset(
  db: Db,
  assetId: string,
  mode: ProbeMode,
  opts: { signal?: AbortSignal; jobId?: string; onProgress?: (p: number) => void; probeTimeoutMs?: number } = {}
): Promise<ProcessOutcome> {
  const asset = await db.asset.findUnique({ where: { id: assetId }, include: { derivatives: true } });
  if (!asset) {
    return { mode, finalStatus: "FAILED", probeMs: 0, probe: null, warnings: [], errorCode: "ASSET_GONE", errorMessage: "素材不存在（可能已删除）" };
  }

  const updateProgress = async (p: number) => {
    opts.onProgress?.(p);
    if (opts.jobId) {
      await db.job
        .updateMany({ where: { id: opts.jobId, status: { in: ["QUEUED", "RUNNING"] } }, data: { progress: p } })
        .catch(() => undefined);
    }
  };

  const probed = await probeAndPersist(db, assetId, mode, mode === "async" ? undefined : opts.probeTimeoutMs, opts.signal);
  if (!probed.ok) {
    if ("timeout" in probed && probed.timeout) {
      return { mode, finalStatus: "RECEIVED", probeMs: null, probe: null, warnings: [], deferredToAsync: true };
    }
    await finishJob(db, opts.jobId, "FAILED", { probeMode: mode, errorCode: probed.errorCode });
    return { mode, finalStatus: "FAILED", probeMs: probed.probeMs, probe: null, warnings: [], errorCode: probed.errorCode, errorMessage: probed.errorMessage };
  }
  const existingMode = await db.asset.findUnique({ where: { id: assetId }, select: { probeMode: true } });
  // 异步转码阶段若复用的是同步探测的元数据，保留 sync 记录，用于对比两种探测路径
  const effectiveMode: ProbeMode = mode === "async" && existingMode?.probeMode === "sync" ? "sync" : mode;
  const { meta, probeMs, warnings } = probed;

  await updateProgress(8);
  const tmpFiles: string[] = [];
  try {
    if (meta.kind === "video") {
      // 缩略图先行 → PREVIEWABLE（播放器绝不能把 RECEIVED 原件当正式源）
      const thumb = await transcodeThumbnail(blobPath((await db.asset.findUniqueOrThrow({ where: { id: assetId }, include: { sourceBlob: true } })).sourceBlob.sha256), meta.durationMs, { signal: opts.signal });
      tmpFiles.push(thumb.path);
      await commitAndRegister(db, asset.id, asset.projectId, "thumbnail", thumb.path, thumb.mimeType, thumb.width, thumb.height);
      await updateProgress(25);
      await assertActiveAndAdvance(db, assetId, "PREVIEWABLE", effectiveMode, probeMs, warnings);

      const full = await db.asset.findUniqueOrThrow({ where: { id: assetId }, include: { sourceBlob: true } });
      const preview = await transcodeVideoPreview(blobPath(full.sourceBlob.sha256), meta.durationMs, {
        signal: opts.signal,
        onProgress: (p) => updateProgress(25 + Math.round(p * 0.7)),
      });
      tmpFiles.push(preview.path);
      await commitAndRegister(db, asset.id, asset.projectId, "video-preview", preview.path, preview.mimeType);
    } else if (meta.kind === "image") {
      const full = await db.asset.findUniqueOrThrow({ where: { id: assetId }, include: { sourceBlob: true } });
      const thumb = await transcodeImageThumbnail(blobPath(full.sourceBlob.sha256), { signal: opts.signal });
      tmpFiles.push(thumb.path);
      await commitAndRegister(db, asset.id, asset.projectId, "thumbnail", thumb.path, thumb.mimeType, thumb.width, thumb.height);
      // 图片原件浏览器原生可渲染，缩略图齐了即完整可用
    } else {
      const full = await db.asset.findUniqueOrThrow({ where: { id: assetId }, include: { sourceBlob: true } });
      const src = blobPath(full.sourceBlob.sha256);
      try {
        const wave = await transcodeWaveform(src, { signal: opts.signal });
        tmpFiles.push(wave.path);
        await commitAndRegister(db, asset.id, asset.projectId, "waveform", wave.path, wave.mimeType, wave.width, wave.height);
      } catch (err) {
        logger.warn({ assetId, err: String(err) }, "waveform generation failed (non-fatal)");
      }
      await updateProgress(25);
      await assertActiveAndAdvance(db, assetId, "PREVIEWABLE", effectiveMode, probeMs, warnings);

      const preview = await transcodeAudioPreview(src, meta.durationMs, {
        signal: opts.signal,
        onProgress: (p) => updateProgress(25 + Math.round(p * 0.7)),
      });
      tmpFiles.push(preview.path);
      await commitAndRegister(db, asset.id, asset.projectId, "audio-preview", preview.path, preview.mimeType);
    }

    await updateProgress(100);
    await assertActiveAndAdvance(db, assetId, "READY", effectiveMode, probeMs, warnings);
    await finishJob(db, opts.jobId, "DONE", { probeMode: mode, warnings });
    return { mode, finalStatus: "READY", probeMs, probe: meta, warnings };
  } catch (err) {
    if ((err as Error).message === "ASSET_DELETED_DURING_TRANSCODE") {
      await finishJob(db, opts.jobId, "CANCELLED", { reason: "asset deleted" });
      return { mode, finalStatus: "FAILED", probeMs, probe: meta, warnings, errorCode: "CANCELLED", errorMessage: "素材在转码期间被删除，产物已丢弃" };
    }
    const code = (err as Error).message?.includes("取消") ? "CANCELLED" : "TRANSCODE_FAILED";
    const current = await db.asset.findUnique({ where: { id: assetId } });
    if (current && current.status === "PREVIEWABLE") {
      // 已可预览但完整版失败：保持 PREVIEWABLE，不能让播放器误把半成品当 READY
      await db.asset.update({
        where: { id: assetId },
        data: { errorCode: code, errorMessage: (err as Error).message, probeMode: mode, probeMs },
      });
      await finishJob(db, opts.jobId, "FAILED", { errorCode: code, error: (err as Error).message });
      return { mode, finalStatus: "PREVIEWABLE", probeMs, probe: meta, warnings, errorCode: code, errorMessage: (err as Error).message };
    }
    await db.asset.updateMany({
      where: { id: assetId },
      data: { status: "FAILED", errorCode: code, errorMessage: (err as Error).message, probeMode: mode, probeMs },
    });
    await finishJob(db, opts.jobId, "FAILED", { errorCode: code, error: (err as Error).message });
    return { mode, finalStatus: "FAILED", probeMs, probe: meta, warnings, errorCode: code, errorMessage: (err as Error).message };
  } finally {
    for (const f of tmpFiles) await cleanupFile(f);
  }
}

async function commitAndRegister(
  db: Db,
  assetId: string,
  projectId: string,
  kind: Parameters<typeof registerDerivative>[0]["kind"],
  localPath: string,
  mimeType: string,
  width?: number,
  height?: number
) {
  const committed = await commitLocalFile(localPath);
  return registerDerivative({ db, projectId, assetId, kind, sha256: committed.sha256, size: committed.size, mimeType, width, height });
}

/**
 * 状态推进保护：删除素材会移除行；转码完成时 update 影响 0 行 → 立即中止并丢弃产物，
 * 绝不“复活”已删除素材（验收：删除素材时转码完成）。
 */
async function assertActiveAndAdvance(
  db: Db,
  assetId: string,
  status: "PREVIEWABLE" | "READY",
  mode: ProbeMode,
  probeMs: number,
  warnings: string[]
) {
  const res = await db.asset.updateMany({
    where: { id: assetId },
    data: {
      status,
      probeMode: mode,
      probeMs,
      errorCode: warnings.includes("NO_AUDIO_STREAM") ? "NO_AUDIO_STREAM" : null,
      errorMessage: warnings.includes("NO_AUDIO_STREAM") ? "该视频不含音轨" : null,
    },
  });
  if (res.count === 0) {
    logger.warn({ assetId, status }, "asset vanished during transcode; discarding output");
    throw new Error("ASSET_DELETED_DURING_TRANSCODE");
  }
}

async function finishJob(
  db: Db,
  jobId: string | undefined,
  status: "DONE" | "FAILED" | "CANCELLED",
  result: Record<string, unknown>
) {
  if (!jobId) return;
  await db.job
    .updateMany({
      where: { id: jobId, status: { in: ["QUEUED", "RUNNING"] } },
      data: { status, finishedAt: new Date(), progress: status === "DONE" ? 100 : undefined, lastError: (result.error as string) ?? null, result: result as object },
    })
    .catch(() => undefined);
}

export async function enqueueTranscodeJob(db: Db, assetId: string, probeMode: ProbeMode = "async") {
  return db.job.create({
    data: { id: randomUUID(), assetId, type: "probe-transcode", status: "QUEUED", probeMode },
  });
}
