import { prisma } from "../../lib/prisma.js";
import { moveIntoBlobStore, removeFileQuiet, sha256File } from "../../lib/storage.js";
import { childLogger } from "../../lib/logger.js";

const log = childLogger("blob");

export interface RegisterInput {
  tmpPath: string;
  sha256?: string;
  sizeBytes: number;
  mimeType: string;
}

export interface BlobRecord {
  id: number;
  sha256: string;
  storagePath: string;
  sizeBytes: number;
  mimeType: string;
  reused: boolean;
}

/**
 * 按 sha256 注册物理字节：
 * - 相同内容（任意来源、任意用户）复用同一个 BlobObject，refCount+1，物理只存一份；
 * - 授权与项目归属在 Asset 上独立维护，不会随字节去重共享。
 */
export async function registerBlob(input: RegisterInput): Promise<BlobRecord> {
  const sha256 = input.sha256 ?? (await sha256File(input.tmpPath));
  const existing = await prisma.blobObject.findUnique({ where: { sha256 } });
  if (existing) {
    await prisma.blobObject.update({
      where: { id: existing.id },
      data: { refCount: { increment: 1 } }
    });
    await removeFileQuiet(input.tmpPath);
    log.info({ sha256, blobId: existing.id }, "blob reused (content deduplication)");
    return {
      id: existing.id,
      sha256,
      storagePath: existing.storagePath,
      sizeBytes: existing.sizeBytes,
      mimeType: existing.mimeType,
      reused: true
    };
  }

  const storagePath = await moveIntoBlobStore(input.tmpPath, sha256);
  const created = await prisma.blobObject.create({
    data: {
      sha256,
      sizeBytes: input.sizeBytes,
      mimeType: input.mimeType,
      storagePath,
      refCount: 1
    }
  });
  log.info({ sha256, blobId: created.id, sizeBytes: input.sizeBytes }, "new blob registered");
  return {
    id: created.id,
    sha256,
    storagePath: created.storagePath,
    sizeBytes: created.sizeBytes,
    mimeType: created.mimeType,
    reused: false
  };
}

/** 释放一次引用；引用归零时删除物理文件与记录。 */
export async function releaseBlob(blobId: number): Promise<void> {
  const blob = await prisma.blobObject.findUnique({ where: { id: blobId } });
  if (!blob) return;
  if (blob.refCount <= 1) {
    await prisma.blobObject.delete({ where: { id: blobId } }).catch(() => undefined);
    await removeFileQuiet(blob.storagePath);
    log.info({ blobId: blob.id, sha256: blob.sha256 }, "blob garbage collected");
  } else {
    await prisma.blobObject.update({
      where: { id: blobId },
      data: { refCount: { decrement: 1 } }
    });
  }
}
