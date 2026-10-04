import type { Db } from "../db.js";
import {
  blobDiskExists,
  blobPath,
  removeBlob,
  removeChunks,
  commitStream,
} from "./blobStore.js";
import { createReadStream } from "node:fs";
import { logger } from "../logger.js";

export type AssetStatus = "RECEIVED" | "PREVIEWABLE" | "READY" | "FAILED";
export type DerivKind = "video-preview" | "audio-preview" | "thumbnail" | "waveform";

/**
 * 登记（或复用）内容寻址 blob，并在项目下创建素材。
 * - 字节相同（sha256 一致）→ 全局复用同一份物理字节；
 * - 但 Asset / BlobReference / 授权均按项目隔离，去重绝不共享项目归属。
 */
export async function registerIngestedBlob(opts: {
  db: Db;
  projectId: string;
  filename: string;
  sha256: string;
  size: number;
  mimeType: string;
  uploadSessionId?: string;
}): Promise<{ assetId: string; created: boolean; blobReused: boolean }> {
  const { db, projectId, filename, sha256, size, mimeType, uploadSessionId } = opts;

  return db.$transaction(async (tx) => {
    // 1) blob：内容寻址，行级唯一
    let blob = await tx.blobObject.findUnique({ where: { sha256 } });
    let blobReused: boolean;
    if (blob) {
      blobReused = true;
    } else {
      blob = await tx.blobObject.create({
        data: { sha256, size: BigInt(size), mimeType },
      });
      blobReused = false;
    }

    // 2) 完成请求幂等：同 uploadSessionId 重试直接返回既有素材
    if (uploadSessionId) {
      const existing = await tx.asset.findUnique({
        where: { uploadSessionId },
      });
      if (existing) {
        return { assetId: existing.id, created: false, blobReused };
      }
    }

    // 3) 项目内素材：同项目同字节复用是合法的（可作为不同素材），
    //    但不同项目互不可见；这里不因去重把别人项目的素材返回。
    const asset = await tx.asset.create({
      data: {
        projectId,
        sourceBlobId: blob.id,
        uploadSessionId: uploadSessionId ?? null,
        filename,
        kind: "unknown", // probe 后更新
        mimeType,
        size: BigInt(size),
        sha256,
        status: "RECEIVED",
      },
    });

    // 4) 引用关系（项目级）：GC 与鉴权都以它为准
    await tx.blobReference.create({
      data: {
        blobId: blob.id,
        projectId,
        assetId: asset.id,
        kind: "source",
      },
    });

    await tx.blobObject.update({
      where: { id: blob.id },
      data: { refCount: { increment: 1 } },
    });

    return { assetId: asset.id, created: true, blobReused };
  });
}

/** 派生预览登记：内容相同的预览字节也按 sha256 复用，但引用挂在各自项目 */
export async function registerDerivative(opts: {
  db: Db;
  projectId: string;
  assetId: string;
  kind: DerivKind;
  sha256: string;
  size: number;
  mimeType: string;
  width?: number;
  height?: number;
}): Promise<{ derivativeId: string; blobReused: boolean }> {
  const { db, projectId, assetId, kind, sha256, size, mimeType, width, height } = opts;

  return db.$transaction(async (tx) => {
    const existing = await tx.derivative.findUnique({
      where: { assetId_kind: { assetId, kind } },
    });
    if (existing) {
      return { derivativeId: existing.id, blobReused: false };
    }
    let blob = await tx.blobObject.findUnique({ where: { sha256 } });
    let blobReused: boolean;
    if (blob) {
      blobReused = true;
    } else {
      blob = await tx.blobObject.create({
        data: { sha256, size: BigInt(size), mimeType },
      });
      blobReused = false;
    }
    const derivative = await tx.derivative.create({
      data: {
        assetId,
        blobId: blob.id,
        kind,
        mimeType,
        size: BigInt(size),
        width: width ?? null,
        height: height ?? null,
      },
    });
    await tx.blobReference.create({
      data: { blobId: blob.id, projectId, assetId, derivativeId: derivative.id, kind: "derivative" },
    });
    await tx.blobObject.update({
      where: { id: blob.id },
      data: { refCount: { increment: 1 } },
    });
    return { derivativeId: derivative.id, blobReused };
  });
}

/**
 * 删除素材：先标记（防止 worker 把跑完的半成品写回），再清理 DB；
 * 物理字节只在全项目都无引用时才回收。
 */
export async function deleteAsset(db: Db, projectId: string, assetId: string): Promise<void> {
  const asset = await db.asset.findFirst({ where: { id: assetId, projectId } });
  if (!asset) return;

  const derivatives = await db.derivative.findMany({ where: { assetId } });
  const blobIds = new Set<string>([asset.sourceBlobId, ...derivatives.map((d) => d.blobId)]);

  // 解绑上传会话（保留可恢复性信息的场景由调用方决定；这里只断开外键）
  await db.$transaction([
    db.job.updateMany({
      where: { assetId, status: { in: ["QUEUED", "RUNNING"] } },
      data: { status: "CANCELLED", finishedAt: new Date(), lastError: "asset deleted" },
    }),
    db.derivative.deleteMany({ where: { assetId } }),
    db.blobReference.deleteMany({ where: { assetId } }),
  ]);
  // 取消任务后再删素材：worker 完成时找不到 active 资产，丢弃产物
  await db.asset.delete({ where: { id: assetId } }).catch(() => undefined);
  await removeChunks(asset.uploadSessionId ?? "__none__").catch(() => undefined);
  if (asset.uploadSessionId) {
    await db.uploadSession
      .update({ where: { id: asset.uploadSessionId }, data: { status: "ABORTED", assetId: null } })
      .catch(() => undefined);
  }

  // GC：对每个 blob 重新对账引用，无引用则删物理字节与行
  for (const blobId of blobIds) {
    await garbageCollectBlob(db, blobId);
  }
  logger.info({ assetId, projectId }, "asset deleted and gc scheduled");
}

export async function garbageCollectBlob(db: Db, blobId: string): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const refs = await tx.blobReference.count({ where: { blobId } });
    if (refs > 0) return false;
    const blob = await tx.blobObject.findUnique({ where: { id: blobId } });
    if (!blob) return false;
    // 双保险：确认没有被其他 asset/derivative 作为外键
    const srcUsers = await tx.asset.count({ where: { sourceBlobId: blobId } });
    const derUsers = await tx.derivative.count({ where: { blobId } });
    if (srcUsers + derUsers > 0) return false;
    const sha = blob.sha256;
    await tx.blobObject.delete({ where: { id: blobId } });
    if (blobDiskExists(sha)) {
      await removeBlob(sha).catch((e) =>
        logger.warn({ sha, err: String(e) }, "failed to remove blob file")
      );
    }
    logger.info({ sha256: sha }, "garbage collected orphan blob");
    return true;
  });
}

/** 将 blob 读为流（鉴权由调用方完成） */
export function openBlob(sha256: string) {
  return createReadStream(blobPath(sha256));
}

/** 上传完成后，把临时组装流提交到内容存储，用于非分片路径（远程下载） */
export { commitStream };
