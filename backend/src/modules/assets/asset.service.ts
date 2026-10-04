import { createReadStream, statSync } from "node:fs";
import type { Response } from "express";
import { prisma } from "../../lib/prisma.js";
import { AppError, ErrorCodes } from "../../lib/errors.js";
import { eventBus } from "../../lib/events.js";
import { childLogger } from "../../lib/logger.js";
import { existsSync } from "node:fs";
import { releaseBlob } from "./blob.service.js";
import { bumpGeneration } from "./transcode.service.js";
import { transcodeQueue } from "./worker.service.js";

const log = childLogger("asset");

export interface AssetQuery {
  projectId: number;
  status?: string;
  mediaType?: string;
  keyword?: string;
  page: number;
  pageSize: number;
}

export async function listAssets(query: AssetQuery) {
  const where: Record<string, unknown> = { projectId: query.projectId, deletedAt: null };
  if (query.status && query.status !== "all") where.status = query.status;
  if (query.mediaType && query.mediaType !== "all") where.mediaType = query.mediaType;
  if (query.keyword) where.filename = { contains: query.keyword };

  const [items, total] = await Promise.all([
    prisma.asset.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: {
        renditions: { where: { kind: { in: ["preview", "cover"] } } },
        references: { select: { id: true } }
      }
    }),
    prisma.asset.count({ where })
  ]);
  return { items: items.map(serializeAsset), total, page: query.page, pageSize: query.pageSize };
}

export async function getAsset(projectId: number, assetId: number) {
  const asset = await prisma.asset.findFirst({
    where: { id: assetId, projectId, deletedAt: null },
    include: {
      renditions: true,
      references: { include: { creator: { select: { displayName: true } } } },
      uploader: { select: { id: true, displayName: true } },
      fetchJob: true
    }
  });
  if (!asset) throw new AppError(ErrorCodes.NOT_FOUND, "素材不存在或已被删除", 404);
  return serializeAssetDetail(asset);
}

/**
 * 删除素材（软删除）：立刻对播放器/列表不可见；若转码恰在此时完成，
 * worker 的代际/删除检查会丢弃结果，不会“复活”素材。
 * 源对象引用立即释放；派生引用随 rendition 级联删除后一并释放。
 */
export async function deleteAsset(projectId: number, assetId: number) {
  const asset = await prisma.asset.findFirst({
    where: { id: assetId, projectId, deletedAt: null },
    include: { renditions: true }
  });
  if (!asset) throw new AppError(ErrorCodes.NOT_FOUND, "素材不存在或已被删除", 404);

  const generation = asset.jobGeneration + 1; // 使任何在途作业失效
  const candidateBlobIds = [
    asset.originalBlobId,
    ...asset.renditions.map((r) => r.blobId)
  ].filter((v): v is number => typeof v === "number");

  // 事务内：软删除素材并对引用到的 blob 各释放一次引用（去重计数）。
  // 绝不在事务内删 blob 记录：物理文件 GC 统一在事务后由 releaseBlob 处理。
  await prisma.$transaction(async (tx) => {
    await tx.asset.update({
      where: { id: assetId },
      data: { deletedAt: new Date(), jobGeneration: generation, stage: "deleted", progress: 0 }
    });
    for (const blobId of new Set(candidateBlobIds)) {
      await tx.blobObject.updateMany({
        where: { id: blobId, refCount: { gt: 0 } },
        data: { refCount: { decrement: 1 } }
      });
    }
  });

  // 事务后：引用归零的 blob 删除记录与物理文件（共享字节仍被其他素材引用则保留）
  for (const blobId of new Set(candidateBlobIds)) {
    await releaseBlob(blobId).catch((err) =>
      log.warn({ blobId, err: (err as Error).message }, "release blob after delete failed")
    );
  }

  eventBus.publish({ type: "asset_deleted", assetId, projectId });
  log.info({ assetId, projectId, generation }, "asset soft-deleted");
}

/** 失败素材重试转码：代际 +1，旧结果作废，重新入队。 */
export async function retryTranscode(projectId: number, assetId: number, probeMode: "sync" | "async" = "async") {
  const asset = await prisma.asset.findFirst({
    where: { id: assetId, projectId, deletedAt: null },
    include: { originalBlob: true }
  });
  if (!asset) throw new AppError(ErrorCodes.NOT_FOUND, "素材不存在", 404);
  if (!asset.originalBlobId) {
    throw new AppError(ErrorCodes.CONFLICT, "素材缺少源对象，无法重试", 409);
  }
  const generation = await bumpGeneration(assetId);
  if (probeMode === "async") {
    transcodeQueue.enqueue({ assetId, generation });
  }
  return { assetId, jobGeneration: generation, probeMode };
}

type StreamTarget = "original" | "preview" | "cover";

/**
 * 媒体流：播放器只能拿到 ready 的正式源或 preview/cover 派生。
 * 原件在“完整可用(ready)”前一律 409 拒绝，杜绝把半成品当正式源。
 */
export async function streamAsset(
  projectId: number,
  assetId: number,
  target: StreamTarget,
  reqRange: string | undefined,
  res: Response
) {
  const asset = await prisma.asset.findFirst({
    where: { id: assetId, projectId, deletedAt: null },
    include: { originalBlob: true, renditions: true }
  });
  if (!asset) throw new AppError(ErrorCodes.NOT_FOUND, "素材不存在", 404);

  let filePath: string | null = null;
  let mimeType: string | null = null;
  let size: number | null = null;

  if (target === "cover") {
    const cover = asset.renditions.find((r) => r.kind === "cover" && r.status === "ready");
    const blob = cover?.blobId ? await prisma.blobObject.findUnique({ where: { id: cover.blobId } }) : null;
    if (cover && blob) {
      filePath = blob.storagePath;
      mimeType = cover.mimeType ?? blob.mimeType;
    }
  } else if (target === "preview") {
    if (asset.status !== "previewable" && asset.status !== "ready") {
      throw new AppError(
        ErrorCodes.ASSET_NOT_READY,
        asset.status === "failed" ? "素材处理失败，预览不可用" : "预览尚未生成，请稍候",
        409,
        { reasonCode: "preview_unavailable", status: asset.status, errorCode: asset.errorCode }
      );
    }
    const preview = asset.renditions.find((r) => r.kind === "preview" && r.status === "ready");
    const blob = preview?.blobId ? await prisma.blobObject.findUnique({ where: { id: preview.blobId } }) : null;
    if (preview && blob) {
      filePath = blob.storagePath;
      mimeType = preview.mimeType ?? blob.mimeType;
    }
  } else {
    // 正式源：必须 ready
    if (asset.status !== "ready") {
      throw new AppError(
        ErrorCodes.ASSET_NOT_READY,
        asset.status === "failed"
          ? `素材处理失败：${asset.errorMessage ?? asset.errorCode ?? "未知原因"}`
          : "原件尚未通过完整性校验，不能作为正式源播放",
        409,
        { reasonCode: "original_not_ready", status: asset.status, errorCode: asset.errorCode }
      );
    }
    if (asset.originalBlob) {
      filePath = asset.originalBlob.storagePath;
      mimeType = asset.originalBlob.mimeType;
    }
  }

  if (!filePath || !existsSync(filePath)) {
    throw new AppError(ErrorCodes.NOT_FOUND, "媒体文件在存储中不存在", 404);
  }
  size = statSync(filePath).size;

  // Range 支持，保证视频可拖动
  const range = parseRange(reqRange, size);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", mimeType ?? "application/octet-stream");
  res.setHeader("Cache-Control", "private, max-age=3600");

  if (range) {
    const { start, end } = range;
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    res.setHeader("Content-Length", end - start + 1);
    createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.status(200);
    res.setHeader("Content-Length", size);
    createReadStream(filePath).pipe(res);
  }
}

function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const startStr = match[1];
  const endStr = match[2];
  let start: number;
  let end: number;
  if (startStr === "" && endStr !== "") {
    // suffix range: bytes=-N
    const suffix = Number.parseInt(endStr, 10);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(startStr, 10);
    end = endStr === "" ? size - 1 : Number.parseInt(endStr, 10);
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

type AssetRow = Parameters<typeof serializeAsset>[0];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function serializeAsset(asset: any) {
  const preview = asset.renditions?.find((r: { kind: string }) => r.kind === "preview");
  const cover = asset.renditions?.find((r: { kind: string }) => r.kind === "cover");
  return {
    id: asset.id,
    projectId: asset.projectId,
    filename: asset.filename,
    mediaType: asset.mediaType,
    status: asset.status,
    stage: asset.stage,
    progress: asset.progress,
    hasAudio: asset.hasAudio,
    durationMs: asset.durationMs,
    width: asset.width,
    height: asset.height,
    sizeBytes: asset.sizeBytes,
    source: asset.source,
    sourceUrl: asset.sourceUrl,
    errorCode: asset.errorCode,
    errorMessage: asset.errorMessage,
    jobGeneration: asset.jobGeneration,
    referenceCount: asset.references?.length ?? asset._referenceCount ?? 0,
    previewReady: preview?.status === "ready",
    coverReady: cover?.status === "ready",
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
    uploader: asset.uploader
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function serializeAssetDetail(asset: any) {
  return {
    ...serializeAsset(asset),
    renditions: (asset.renditions ?? []).map((r: Record<string, unknown>) => r),
    references: asset.references ?? [],
    fetchJob: asset.fetchJob ?? null
  };
}

export type { AssetRow };
