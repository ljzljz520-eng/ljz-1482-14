import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { prisma } from "../../lib/prisma.js";
import { AppError, ErrorCodes } from "../../lib/errors.js";
import { eventBus } from "../../lib/events.js";
import { childLogger } from "../../lib/logger.js";
import {
  deriveCover,
  derivePreview,
  extractFfmpegError,
  MIME,
  probeMedia,
  type MediaKind,
  type MediaProbe
} from "../../lib/mediaService.js";
import { fileSize, renditionPath, sha256File } from "../../lib/storage.js";
import { registerBlob, releaseBlob } from "./blob.service.js";

const log = childLogger("transcode");

const PREVIEW_EXT: Record<MediaKind, string> = { video: "mp4", audio: "m4a", image: "jpg" };

const SUPPORTED_MIME_PREFIX = ["video/", "audio/", "image/"];
const SUPPORTED_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|mp3|m4a|aac|wav|flac|ogg|opus|png|jpe?g|gif|webp|bmp|avif)$/i;

/** 支持的媒体类型；非音视频/图片直接拒绝，而不是当作未知流处理。 */
export function validateInputType(filename: string, mimeType: string): void {
  const prefixOk = SUPPORTED_MIME_PREFIX.some((p) => mimeType.toLowerCase().startsWith(p));
  const extOk = SUPPORTED_EXT.test(filename);
  if (!prefixOk && !extOk) {
    throw new AppError(
      ErrorCodes.UNSUPPORTED_MEDIA,
      `不支持的素材类型（${mimeType || "未知 MIME"}），仅允许音频、视频或图片`,
      422,
      { reasonCode: "unsupported_media_type", filename, mimeType }
    );
  }
}

export function classifyFilename(filename: string): MediaKind | null {
  if (/\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(filename)) return "image";
  if (/\.(mp3|m4a|aac|wav|flac|ogg|opus)$/i.test(filename)) return "audio";
  if (/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(filename)) return "video";
  return null;
}

async function publishProgress(
  assetId: number,
  projectId: number,
  generation: number,
  status: string,
  stage: string,
  progress: number,
  extra: { errorCode?: string; errorMessage?: string; hasAudio?: boolean } = {}
) {
  const result = await prisma.asset.updateMany({
    where: { id: assetId, jobGeneration: generation, deletedAt: null },
    data: { progress, stage, ...(status !== "previewable" ? { status } : {}) }
  });
  if (result.count === 0) return;
  eventBus.publish({ type: "asset", assetId, projectId, jobGeneration: generation, status, stage, progress, ...extra });
}

/**
 * 对“原件已收”的素材执行完整性探测与派生预览。
 * 每个提交点都检查 jobGeneration：删除素材或触发重新转码会令代际 +1，
 * 旧作业迟到的结果一律丢弃（对应验收：删除素材时转码完成、预览切换后旧回调到达）。
 */
export async function processAsset(assetId: number, generation: number): Promise<void> {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    include: { originalBlob: true, renditions: true }
  });
  if (!asset || asset.deletedAt) return;
  if (asset.jobGeneration !== generation) {
    log.info({ assetId, generation, current: asset.jobGeneration }, "stale generation at start");
    return;
  }
  if (!asset.originalBlob) {
    await failAsset(assetId, generation, "missing_original", "素材缺少源对象记录");
    return;
  }
  const sourcePath = asset.originalBlob.storagePath;
  if (!existsSync(sourcePath)) {
    await failAsset(assetId, generation, "source_file_missing", "源对象物理文件不存在");
    return;
  }

  const abort = new AbortController();
  const snapshot = async () =>
    prisma.asset.findUnique({
      where: { id: assetId },
      select: { jobGeneration: true, deletedAt: true, projectId: true }
    });

  // 过程中创建的 blob 引用，若最终因代际过期未提交，需要逐个释放
  const provisionalBlobIds: number[] = [];

  try {
    await publishProgress(assetId, asset.projectId, generation, "received", "probing", 2);

    let probe: MediaProbe;
    try {
      probe = await probeMedia(sourcePath);
    } catch (err) {
      throw new Error(extractFfmpegError((err as Error).message))
    }

    let state = await snapshot();
    if (!state || state.deletedAt || state.jobGeneration !== generation) {
      abort.abort();
      return;
    }

    const expected = classifyFilename(asset.filename);
    const mediaType = expected ?? probe.mediaType;

    // 关键验收：纯“音频”文件无音轨 => 失败；视频无音轨 => 可就绪但显式标记提示
    if (mediaType === "audio" && !probe.hasAudio) {
      await failAsset(assetId, generation, "audio_track_missing",
        "音频素材缺少可解码音轨，无法作为音频使用（可作为视频上传画面声轨缺失时不受此限）");
      return;
    }

    await prisma.asset.updateMany({
      where: { id: assetId, jobGeneration: generation, deletedAt: null },
      data: {
        mediaType,
        hasAudio: probe.hasAudio,
        durationMs: probe.durationMs,
        width: probe.width,
        height: probe.height,
        stage: "transcoding"
      }
    });
    eventBus.publish({ type: "asset", assetId, projectId: asset.projectId, jobGeneration: generation,
      status: "received", stage: "transcoding", progress: 8 });

    const ext = PREVIEW_EXT[mediaType];
    const previewOut = renditionPath(assetId, "preview", ext);

    const previewRendition =
      asset.renditions.find((r) => r.kind === "preview") ??
      (await prisma.assetRendition.create({
        data: { assetId, kind: "preview", status: "pending", mimeType: MIME[ext] }
      }));

    await derivePreview(
      sourcePath,
      previewOut,
      mediaType,
      (p) => {
        const mapped = 10 + Math.round(p * 0.72);
        void publishProgress(assetId, asset.projectId, generation, "previewable", "transcoding", mapped, {
          hasAudio: probe.hasAudio
        });
      },
      abort.signal
    );

    state = await snapshot();
    if (!state || state.deletedAt || state.jobGeneration !== generation) {
      await rm(previewOut, { force: true }).catch(() => undefined);
      abort.abort();
      return;
    }

    const previewBlob = await registerBlob({
      tmpPath: previewOut,
      sha256: await sha256File(previewOut),
      sizeBytes: await fileSize(previewOut),
      mimeType: MIME[ext]
    });
    provisionalBlobIds.push(previewBlob.id);

    // 视频封面（非关键路径，失败不阻断就绪）
    let coverBlobId: number | null = null;
    let coverSize: number | null = null;
    if (mediaType === "video") {
      const coverOut = renditionPath(assetId, "cover", "jpg");
      try {
        await deriveCover(sourcePath, coverOut, probe.durationMs);
        const coverBlob = await registerBlob({
          tmpPath: coverOut,
          sha256: await sha256File(coverOut),
          sizeBytes: await fileSize(coverOut),
          mimeType: MIME.jpg
        });
        provisionalBlobIds.push(coverBlob.id);
        coverBlobId = coverBlob.id;
        coverSize = coverBlob.sizeBytes;
      } catch (err) {
        log.warn({ assetId, err: (err as Error).message }, "cover derivation failed (non-fatal)");
      }
    }

    // 唯一提交点：代际/删除状态不匹配则整体放弃
    const commit = await prisma.$transaction(async (tx) => {
      const current = await tx.asset.findUnique({
        where: { id: assetId },
        include: { renditions: true }
      });
      if (!current || current.deletedAt || current.jobGeneration !== generation) return null;

      const oldPreviewBlobId = current.renditions.find((r) => r.kind === "preview" && r.blobId)?.blobId ?? null;
      const oldCoverBlobId = current.renditions.find((r) => r.kind === "cover" && r.blobId)?.blobId ?? null;

      await tx.assetRendition.update({
        where: { id: previewRendition.id },
        data: {
          status: "ready",
          blobId: previewBlob.id,
          mimeType: MIME[ext],
          width: probe.width,
          height: probe.height,
          durationMs: probe.durationMs,
          sizeBytes: previewBlob.sizeBytes,
          errorCode: null
        }
      });

      if (coverBlobId !== null) {
        const existing = current.renditions.find((r) => r.kind === "cover");
        if (existing) {
          await tx.assetRendition.update({
            where: { id: existing.id },
            data: { status: "ready", blobId: coverBlobId, mimeType: MIME.jpg,
              width: probe.width, height: probe.height, sizeBytes: coverSize, errorCode: null }
          });
        } else {
          await tx.assetRendition.create({
            data: { assetId, kind: "cover", status: "ready", blobId: coverBlobId,
              mimeType: MIME.jpg, width: probe.width, height: probe.height, sizeBytes: coverSize }
          });
        }
      }

      await tx.asset.update({
        where: { id: assetId },
        data: {
          status: "ready",
          stage: "complete",
          progress: 100,
          mediaType,
          hasAudio: probe.hasAudio,
          durationMs: probe.durationMs,
          width: probe.width,
          height: probe.height,
          errorCode: null,
          errorMessage: null
        }
      });

      return { oldPreviewBlobId, oldCoverBlobId };
    });

    if (!commit) {
      for (const id of provisionalBlobIds) await releaseBlob(id).catch(() => undefined);
      log.info({ assetId }, "commit rejected: generation moved on or asset deleted");
      return;
    }
    // 旧派生引用在提交成功后释放（与新 blob 无重合时）
    const superseded = [commit.oldPreviewBlobId, commit.oldCoverBlobId].filter(
      (id): id is number => id !== null && !provisionalBlobIds.includes(id)
    );
    for (const id of superseded) await releaseBlob(id).catch(() => undefined);

    eventBus.publish({ type: "asset", assetId, projectId: asset.projectId,
      jobGeneration: generation, status: "ready", stage: "complete", progress: 100, hasAudio: probe.hasAudio });
    log.info({ assetId, mediaType, hasAudio: probe.hasAudio, reusedPreview: previewBlob.reused }, "asset ready");
  } catch (err) {
    const state = await snapshot();
    if (!state || state.deletedAt || state.jobGeneration !== generation) {
      for (const id of provisionalBlobIds) await releaseBlob(id).catch(() => undefined);
      log.info({ assetId }, "error from stale generation ignored");
      return;
    }
    const message = (err as Error).message;
    const code = /无法解析|Invalid data|moov|does not contain|Invalid argument/i.test(message)
      ? "invalid_media"
      : "transcode_failed";
    await failAsset(assetId, generation, code, message.slice(0, 2000));
  }
}

async function failAsset(assetId: number, generation: number, code: string, message: string) {
  const result = await prisma.asset.updateMany({
    where: { id: assetId, jobGeneration: generation, deletedAt: null },
    data: { status: "failed", stage: "failed", progress: 0, errorCode: code, errorMessage: message }
  });
  if (result.count === 0) return;
  const asset = await prisma.asset.findUnique({ where: { id: assetId }, select: { projectId: true } });
  if (asset) {
    eventBus.publish({ type: "asset", assetId, projectId: asset.projectId,
      jobGeneration: generation, status: "failed", stage: "failed", progress: 0,
      errorCode: code, errorMessage: message });
  }
  log.warn({ assetId, code }, "asset failed");
}

/** 重新转码：代际 +1 使任何在途旧作业失效，返回新代际。 */
export async function bumpGeneration(assetId: number): Promise<number> {
  const updated = await prisma.asset.update({
    where: { id: assetId },
    data: {
      jobGeneration: { increment: 1 },
      status: "received",
      stage: "queued",
      progress: 0,
      errorCode: null,
      errorMessage: null
    }
  });
  return updated.jobGeneration;
}
