import { Readable } from "node:stream";
import { config } from "../config.js";
import type { Db } from "../db.js";
import {
  ChecksumMismatchError,
  PayloadTooLargeError,
  commitStream,
  readChunks,
  removeChunks,
  writeChunk,
} from "./blobStore.js";
import { logger } from "../logger.js";

export interface CreateSessionInput {
  filename: string;
  totalSize: number;
  chunkSize: number;
  sha256?: string;
}

export async function createUploadSession(db: Db, projectId: string, input: CreateSessionInput) {
  if (!input.filename || input.filename.length > 255) {
    throw new ValidationError("filename 非法或过长");
  }
  if (!Number.isInteger(input.totalSize) || input.totalSize <= 0) {
    throw new ValidationError("totalSize 必须为正整数");
  }
  if (input.totalSize > config.MAX_UPLOAD_BYTES) {
    throw new PayloadTooLargeError(config.MAX_UPLOAD_BYTES, input.totalSize);
  }
  if (!Number.isInteger(input.chunkSize) || input.chunkSize <= 0 || input.chunkSize > 64 * 1024 * 1024) {
    throw new ValidationError("chunkSize 必须为 1B~64MiB 之间的整数");
  }
  const totalChunks = Math.ceil(input.totalSize / input.chunkSize);
  if (totalChunks > 10_000) {
    throw new ValidationError("分片数量超过上限 10000");
  }
  const session = await db.uploadSession.create({
    data: {
      projectId,
      filename: input.filename,
      totalSize: BigInt(input.totalSize),
      chunkSize: input.chunkSize,
      totalChunks,
      sha256: input.sha256 ?? null,
      status: "OPEN",
    },
  });
  return session;
}

export async function getSession(db: Db, projectId: string, uploadId: string) {
  const session = await db.uploadSession.findUnique({
    where: { id: uploadId },
    include: { chunks: { orderBy: { index: "asc" } } },
  });
  if (!session || session.projectId !== projectId) return null;
  return session;
}

export async function abortSession(db: Db, projectId: string, uploadId: string) {
  const session = await getSession(db, projectId, uploadId);
  if (!session) return false;
  await db.uploadSession.update({
    where: { id: uploadId },
    data: { status: "ABORTED" },
  });
  await removeChunks(uploadId).catch(() => undefined);
  return true;
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * 接收一个分片：以「对象身份 uploadId + 块范围 index」定位；
 * 可选客户端 sha256，服务端对流做全量校验。重复 PUT 同一已存在且校验一致的块 → 幂等返回。
 */
export async function putChunk(opts: {
  db: Db;
  projectId: string;
  uploadId: string;
  index: number;
  stream: Readable;
  clientSha256?: string;
}) {
  const { db, projectId, uploadId, index, stream, clientSha256 } = opts;
  const session = await getSession(db, projectId, uploadId);
  if (!session) throw new ValidationError("上传会话不存在或已失效");
  if (session.status !== "OPEN") {
    throw new ValidationError(`上传会话状态为 ${session.status}，无法继续写入`);
  }
  if (!Number.isInteger(index) || index < 0 || index >= session.totalChunks) {
    throw new ValidationError(`index 必须在 [0, ${session.totalChunks - 1}] 内`);
  }

  const expectedOffset = Number(session.totalSize) === 0 ? 0 : index * session.chunkSize;
  const start = index * session.chunkSize;
  const end = Math.min(start + session.chunkSize, Number(session.totalSize));
  const maxChunkBytes = end - start;

  // 断点续传：块已收且校验一致 → 直接幂等返回（重复 PUT 不重复计费/写盘）
  const existed = await db.uploadChunk.findUnique({
    where: { uploadId_index: { uploadId, index } },
  });
  if (existed) {
    if (clientSha256 && existed.sha256 === clientSha256) {
      return { index, offset: Number(existed.offset), size: Number(existed.size), sha256: existed.sha256, reused: true };
    }
    // 客户端没带校验值或不一致：重写（允许重试覆盖）
  }
  void expectedOffset;

  const { sha256, size } = await writeChunk(uploadId, index, stream, clientSha256, maxChunkBytes);
  if (size !== maxChunkBytes) {
    throw new ValidationError(
      `第 ${index} 块大小应为 ${maxChunkBytes} 字节（offset=${start}），实际 ${size}`
    );
  }

  const row = await db.uploadChunk.upsert({
    where: { uploadId_index: { uploadId, index } },
    create: { uploadId, index, offset: BigInt(start), size: BigInt(size), sha256 },
    update: { offset: BigInt(start), size: BigInt(size), sha256, receivedAt: new Date() },
  });
  return { index, offset: start, size, sha256: row.sha256, reused: false };
}

/**
 * 完成上传：
 * 1) 校验所有块齐了；2) 按序组装 + 全量 sha256（与客户端声明比对）；
 * 3) 内容寻址落盘（字节去重）；4) 事务登记素材。
 * 任何一步失败都保持会话 OPEN，客户端可用同样的 uploadId 恢复。
 */
export async function completeUpload(
  db: Db,
  projectId: string,
  uploadId: string,
  clientSha256?: string
): Promise<{ assetId: string; created: boolean; sha256: string; size: number; blobReused: boolean }> {
  const session = await getSession(db, projectId, uploadId);
  if (!session) throw new ValidationError("上传会话不存在或已失效");

  // 已完成会话重试：幂等返回同一素材（完成请求重试不能创建重复素材）
  if (session.status === "COMPLETED" && session.assetId) {
    const a = await db.asset.findUnique({ where: { id: session.assetId } });
    if (a) {
      return { assetId: a.id, created: false, sha256: a.sha256, size: Number(a.size), blobReused: true };
    }
  }
  if (session.status === "ABORTED") {
    throw new ValidationError("上传会话已中止");
  }

  const chunkCount = await db.uploadChunk.count({ where: { uploadId } });
  if (chunkCount !== session.totalChunks) {
    const have = new Set(session.chunks.map((c) => c.index));
    const missing: number[] = [];
    for (let i = 0; i < session.totalChunks; i++) if (!have.has(i)) missing.push(i);
    const err = new ValidationError(`尚缺 ${missing.length} 个分片，无法完成`);
    (err as ValidationError & { missing?: number[] }).missing = missing.slice(0, 50);
    throw err;
  }

  // 顺序组装流
  const expected = clientSha256 ?? session.sha256 ?? undefined;
  let committed: { sha256: string; size: number; reused: boolean };
  try {
    const combined = Readable.from((async function* () {
      for (const part of readChunks(uploadId, session.totalChunks)) {
        for await (const c of part) yield c as Buffer;
      }
    })());
    committed = await commitStream(combined, expected);
  } catch (err) {
    if (err instanceof ChecksumMismatchError) {
      throw new ValidationError(`整体校验失败：${err.message}`);
    }
    throw err;
  }
  if (committed.size !== Number(session.totalSize)) {
    throw new ValidationError(
      `组装后大小 ${committed.size} 与声明 ${Number(session.totalSize)} 不符`
    );
  }

  // 登记素材（事务内完成，完成请求并发重试由 uploadSessionId 唯一约束兜底）
  const { registerIngestedBlob } = await import("./assetService.js");
  const result = await registerIngestedBlob({
    db,
    projectId,
    filename: session.filename,
    sha256: committed.sha256,
    size: committed.size,
    mimeType: guessMime(session.filename),
    uploadSessionId: uploadId,
  });

  await db.uploadSession.update({
    where: { id: uploadId },
    data: { status: "COMPLETED", completedAt: new Date(), assetId: result.assetId },
  });
  await removeChunks(uploadId).catch((e) =>
    logger.warn({ uploadId, err: String(e) }, "failed to cleanup chunks")
  );

  return {
    assetId: result.assetId,
    created: result.created,
    sha256: committed.sha256,
    size: committed.size,
    blobReused: result.blobReused || committed.reused,
  };
}

function guessMime(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return (
    {
      mp4: "video/mp4",
      mov: "video/quicktime",
      webm: "video/webm",
      mkv: "video/x-matroska",
      avi: "video/x-msvideo",
      mp3: "audio/mpeg",
      wav: "audio/wav",
      m4a: "audio/mp4",
      aac: "audio/aac",
      flac: "audio/flac",
      ogg: "audio/ogg",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      webp: "image/webp",
      bmp: "image/bmp",
      tiff: "image/tiff",
    }[ext] ?? "application/octet-stream"
  );
}

/** 列出已收分片（断点恢复时客户端据此决定续传范围） */
export async function listReceived(db: Db, projectId: string, uploadId: string) {
  const session = await getSession(db, projectId, uploadId);
  if (!session) return null;
  return {
    uploadId: session.id,
    filename: session.filename,
    totalSize: Number(session.totalSize),
    chunkSize: session.chunkSize,
    totalChunks: session.totalChunks,
    status: session.status,
    assetId: session.assetId,
    received: session.chunks.map((c) => ({
      index: c.index,
      offset: Number(c.offset),
      size: Number(c.size),
      sha256: c.sha256,
    })),
  };
}

