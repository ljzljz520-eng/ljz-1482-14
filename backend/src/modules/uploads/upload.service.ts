import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { AppError, ErrorCodes } from "../../lib/errors.js";
import { childLogger } from "../../lib/logger.js";
import {
  chunkPath,
  fileSize,
  removeDirQuiet,
  removeFileQuiet,
  sessionChunkDir,
  sha256File,
  tmpPath
} from "../../lib/storage.js";
import { registerBlob, releaseBlob } from "../assets/blob.service.js";
import { transcodeQueue } from "../assets/worker.service.js";
import { validateInputType } from "../assets/transcode.service.js";

const log = childLogger("upload");

export interface CreateSessionInput {
  projectId: number;
  userId: number;
  clientToken: string;
  filename: string;
  declaredSize: number;
  chunkSize: number;
  sha256Expected?: string | null;
  contentType?: string | null;
}

/**
 * 创建分片上传会话（对象身份 = clientToken，幂等）。
 * 中断恢复时前端用同一 token 重新调用，拿到已收块范围而不是创建新会话。
 */
export async function createSession(input: CreateSessionInput) {
  if (input.declaredSize <= 0) {
    throw new AppError(ErrorCodes.VALIDATION, "文件大小必须为正整数", 422);
  }
  if (input.declaredSize > env.maxAssetBytes) {
    throw new AppError(
      ErrorCodes.ASSET_TOO_LARGE,
      `文件 ${input.declaredSize} 字节超过单素材上限 ${env.maxAssetBytes} 字节，已在上传前拒绝`,
      413,
      { reasonCode: "declared_size_exceeded", declaredSize: input.declaredSize, maxBytes: env.maxAssetBytes }
    );
  }
  if (input.chunkSize < 256 * 1024) {
    throw new AppError(ErrorCodes.VALIDATION, "分片大小不能小于 256KB", 422);
  }
  validateInputType(input.filename, input.contentType ?? "application/octet-stream");

  const totalChunks = Math.ceil(input.declaredSize / input.chunkSize);
  const expiresAt = new Date(Date.now() + env.sessionTtlHours * 3600_000);

  // 幂等：同一 clientToken 已存在则返回原会话（绝不重复创建）
  const existing = await prisma.uploadSession.findUnique({
    where: { clientToken: input.clientToken },
    include: { chunks: { orderBy: { index: "asc" } } }
  });
  if (existing) {
    if (existing.projectId !== input.projectId || existing.uploaderId !== input.userId) {
      throw new AppError(ErrorCodes.CONFLICT, "上传标识已被其他上下文使用", 409);
    }
    if (existing.filename !== input.filename || existing.declaredSize !== input.declaredSize) {
      throw new AppError(
        ErrorCodes.CONFLICT,
        "同名上传标识的文件参数不一致，请生成新的上传标识后重试",
        409,
        { reasonCode: "session_parameter_mismatch" }
      );
    }
    return serializeSession(existing);
  }

  const session = await prisma.uploadSession.create({
    data: {
      projectId: input.projectId,
      uploaderId: input.userId,
      clientToken: input.clientToken,
      filename: input.filename,
      declaredSize: input.declaredSize,
      chunkSize: input.chunkSize,
      totalChunks,
      sha256Expected: input.sha256Expected ?? null,
      expiresAt
    },
    include: { chunks: { orderBy: { index: "asc" } } }
  });
  log.info({ sessionId: session.id, filename: input.filename, totalChunks }, "upload session created");
  return serializeSession(session);
}

export async function getSession(projectId: number, sessionId: number) {
  const session = await prisma.uploadSession.findFirst({
    where: { id: sessionId, projectId },
    include: { chunks: { orderBy: { index: "asc" } } }
  });
  if (!session) throw new AppError(ErrorCodes.NOT_FOUND, "上传会话不存在", 404);
  return serializeSession(session);
}

export interface PutChunkInput {
  projectId: number;
  sessionId: number;
  index: number;
  body: Buffer;
  checksum: string;
}

/**
 * 写入一个分片。恢复三要素：
 * - 对象身份：sessionId + index；
 * - 块范围：服务端按 offset/长度核验该块应处字节区间；
 * - 校验值：每块 sha256，不一致拒收（422），一致重传幂等（200）。
 */
export async function putChunk(input: PutChunkInput) {
  const session = await prisma.uploadSession.findFirst({
    where: { id: input.sessionId, projectId: input.projectId },
    include: { chunks: true }
  });
  if (!session) throw new AppError(ErrorCodes.NOT_FOUND, "上传会话不存在", 404);
  if (session.status === "completed") {
    throw new AppError(ErrorCodes.CONFLICT, "上传已完成，不能再写入分片", 409, {
      reasonCode: "session_completed"
    });
  }
  if (session.status === "aborted") {
    throw new AppError(ErrorCodes.CONFLICT, "上传会话已中止", 409, { reasonCode: "session_aborted" });
  }
  if (session.expiresAt < new Date()) {
    throw new AppError(ErrorCodes.SESSION_EXPIRED, "上传会话已过期，请重新创建", 410);
  }
  if (input.index < 0 || input.index >= session.totalChunks) {
    throw new AppError(
      ErrorCodes.VALIDATION,
      `分片序号越界：${input.index}，有效范围 0..${session.totalChunks - 1}`,
      422,
      { reasonCode: "index_out_of_range" }
    );
  }

  const expectedOffset = input.index * session.chunkSize;
  const expectedSize =
    input.index === session.totalChunks - 1 ? session.declaredSize - expectedOffset : session.chunkSize;

  // 块范围：长度必须精确匹配该块应覆盖的字节区间
  if (input.body.length !== expectedSize) {
    throw new AppError(
      ErrorCodes.CHUNK_MISMATCH,
      `分片 ${input.index} 大小不符：期望 ${expectedSize} 字节，实际 ${input.body.length} 字节`,
      422,
      { reasonCode: "chunk_size_mismatch", index: input.index, expectedSize, actualSize: input.body.length }
    );
  }

  const actualChecksum = sha256Buffer(input.body);
  if (input.checksum && actualChecksum !== input.checksum.toLowerCase()) {
    throw new AppError(
      ErrorCodes.CHUNK_CHECKSUM,
      `分片 ${input.index} 校验失败，请重传该分片`,
      422,
      { reasonCode: "checksum_mismatch", index: input.index }
    );
  }

  const existing = session.chunks.find((c) => c.index === input.index);
  if (existing) {
    if (existing.sha256 === actualChecksum && existing.size === expectedSize) {
      return getSession(session.projectId, session.id); // 幂等重传
    }
    throw new AppError(
      ErrorCodes.CONFLICT,
      `分片 ${input.index} 已存在但内容不同，请新建上传会话`,
      409,
      { reasonCode: "chunk_content_conflict" }
    );
  }

  if (session.bytesReceived + expectedSize > session.declaredSize) {
    throw new AppError(ErrorCodes.ASSET_TOO_LARGE, "累计分片超过声明文件大小，已拒绝", 413, {
      reasonCode: "bytes_exceed_declared"
    });
  }

  const destination = chunkPath(session.id, input.index);
  await pipeline(Readable.from(input.body), createWriteStream(destination));

  await prisma.$transaction([
    prisma.uploadChunk.create({
      data: {
        sessionId: session.id,
        index: input.index,
        offset: expectedOffset,
        size: expectedSize,
        sha256: actualChecksum
      }
    }),
    prisma.uploadSession.update({
      where: { id: session.id },
      data: { bytesReceived: { increment: expectedSize } }
    })
  ]);

  log.debug({ sessionId: session.id, index: input.index }, "chunk accepted");
  return getSession(session.projectId, session.id);
}

function sha256Buffer(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

export interface CompleteInput {
  projectId: number;
  userId: number;
  sessionId: number;
  probeMode: "sync" | "async";
}

/**
 * 完成上传：组装分片 -> 校验整体哈希 -> 登记源对象 -> 建素材 -> 入转码。
 * 完成请求重试绝不创建重复素材：session 唯一关联 asset，已完成直接返回同一素材。
 */
export async function completeSession(input: CompleteInput) {
  const session = await prisma.uploadSession.findFirst({
    where: { id: input.sessionId, projectId: input.projectId },
    include: { chunks: true, asset: { include: { renditions: true } } }
  });
  if (!session) throw new AppError(ErrorCodes.NOT_FOUND, "上传会话不存在", 404);

  // 幂等：完成请求重试直接返回既有素材
  if (session.status === "completed" && session.asset) {
    log.info({ sessionId: session.id, assetId: session.asset.id }, "duplicate complete, return existing asset");
    return { asset: session.asset, alreadyExisted: true };
  }
  if (session.status !== "active") {
    throw new AppError(ErrorCodes.CONFLICT, `会话状态 ${session.status} 无法完成`, 409);
  }
  if (session.expiresAt < new Date()) {
    throw new AppError(ErrorCodes.SESSION_EXPIRED, "上传会话已过期，请重新上传", 410);
  }
  if (session.chunks.length !== session.totalChunks) {
    const received = session.chunks.map((c) => c.index).sort((a, b) => a - b);
    throw new AppError(
      ErrorCodes.CONFLICT,
      `分片不完整：已收 ${session.chunks.length}/${session.totalChunks}，请断点续传后再完成`,
      409,
      { reasonCode: "missing_chunks", received, totalChunks: session.totalChunks }
    );
  }
  const sorted = [...session.chunks].sort((a, b) => a.index - b.index);
  for (let i = 0; i < sorted.length; i += 1) {
    if (sorted[i].index !== i) {
      throw new AppError(ErrorCodes.CONFLICT, `缺少分片 ${i}，无法组装`, 409, {
        reasonCode: "gap_in_chunks",
        missing: i
      });
    }
  }
  if (session.bytesReceived !== session.declaredSize) {
    throw new AppError(
      ErrorCodes.CONFLICT,
      `字节数不一致：已收 ${session.bytesReceived}，声明 ${session.declaredSize}`,
      409,
      { reasonCode: "size_mismatch" }
    );
  }

  const assembled = tmpPath(`assembled-${session.id}`);
  try {
    // 流式顺序拼接，避免一次性读入内存
    await new Promise<void>((resolve, reject) => {
      const writer = createWriteStream(assembled);
      let chain: Promise<void> = Promise.resolve();
      for (const chunk of sorted) {
        chain = chain.then(
          () =>
            new Promise<void>((res, rej) => {
              const reader = createReadStream(chunkPath(session.id, chunk.index));
              reader.on("error", rej);
              reader.on("end", res);
              reader.pipe(writer, { end: false });
            })
        );
      }
      chain
        .then(() => writer.end())
        .then(() => resolve())
        .catch((err) => {
          writer.destroy();
          reject(err);
        });
    });

    const actualSize = await fileSize(assembled);
    if (actualSize !== session.declaredSize) {
      throw new AppError(
        ErrorCodes.CONFLICT,
        `组装后大小 ${actualSize} 与声明 ${session.declaredSize} 不符`,
        409,
        { reasonCode: "assembled_size_mismatch" }
      );
    }
    if (session.sha256Expected) {
      const actualHash = await sha256File(assembled);
      if (actualHash !== session.sha256Expected.toLowerCase()) {
        throw new AppError(
          ErrorCodes.CHUNK_CHECKSUM,
          "整体文件 SHA256 校验失败：内容与上传前声明不一致",
          422,
          { reasonCode: "whole_file_checksum_mismatch" }
        );
      }
    }

    const mimeType = guessMime(session.filename);
    validateInputType(session.filename, mimeType);

    const blob = await registerBlob({ tmpPath: assembled, sizeBytes: actualSize, mimeType });

    let asset;
    try {
      asset = await prisma.asset.create({
        data: {
          projectId: session.projectId,
          uploaderId: session.uploaderId,
          originalBlobId: blob.id,
          uploadSessionId: session.id,
          filename: session.filename,
          mediaType: guessMediaKind(session.filename),
          status: "received",
          stage: "queued",
          sizeBytes: actualSize,
          source: "upload",
          probeMode: input.probeMode
        },
        include: { renditions: true }
      });
    } catch (err) {
      // 唯一键冲突 => 并发的另一完成请求已建素材：释放多余引用，返回既有素材
      if ((err as { code?: string }).code === "P2002") {
        await releaseBlob(blob.id).catch(() => undefined);
        const existingAsset = await prisma.asset.findUnique({
          where: { uploadSessionId: session.id },
          include: { renditions: true }
        });
        if (existingAsset) {
          await prisma.uploadSession.updateMany({
            where: { id: session.id, status: "active" },
            data: { status: "completed", completedAt: new Date(), bytesReceived: actualSize, assetId: existingAsset.id }
          });
          return { asset: existingAsset, alreadyExisted: true };
        }
      }
      throw err;
    }

    await prisma.uploadSession.update({
      where: { id: session.id },
      data: { status: "completed", completedAt: new Date(), assetId: asset.id }
    });
    removeDirQuiet(sessionChunkDir(session.id));

    if (input.probeMode === "async") {
      transcodeQueue.enqueue({ assetId: asset.id, generation: asset.jobGeneration });
    }
    log.info(
      { assetId: asset.id, blobReused: blob.reused, probeMode: input.probeMode },
      "upload completed"
    );
    return { asset, alreadyExisted: false, probeInline: input.probeMode === "sync" };
  } finally {
    await removeFileQuiet(assembled);
  }
}

/** 中止会话：未完成上传的分片立即清理，不占用 blob 存储。 */
export async function abortSession(projectId: number, sessionId: number) {
  const session = await prisma.uploadSession.findFirst({ where: { id: sessionId, projectId } });
  if (!session) throw new AppError(ErrorCodes.NOT_FOUND, "上传会话不存在", 404);
  if (session.status !== "completed") {
    await prisma.uploadSession.update({ where: { id: session.id }, data: { status: "aborted" } });
    removeDirQuiet(sessionChunkDir(session.id));
  }
}

export function guessMime(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska",
    avi: "video/x-msvideo", m4v: "video/x-m4v",
    mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav",
    flac: "audio/flac", ogg: "audio/ogg", opus: "audio/ogg",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", bmp: "image/bmp", avif: "image/avif"
  };
  return map[ext] ?? "application/octet-stream";
}

export function guessMediaKind(filename: string): "video" | "audio" | "image" {
  const mime = guessMime(filename);
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  return "video";
}

interface SessionLike {
  id: number;
  projectId: number;
  filename: string;
  declaredSize: number;
  chunkSize: number;
  totalChunks: number;
  status: string;
  bytesReceived: number;
  sha256Expected: string | null;
  expiresAt: Date;
  assetId: number | null;
  chunks: Array<{ index: number; size: number; sha256: string }>;
}

export function serializeSession(session: SessionLike) {
  const received = new Set(session.chunks.map((c) => c.index));
  const missing: number[] = [];
  for (let i = 0; i < session.totalChunks; i += 1) {
    if (!received.has(i)) missing.push(i);
  }
  return {
    id: session.id,
    projectId: session.projectId,
    filename: session.filename,
    declaredSize: session.declaredSize,
    chunkSize: session.chunkSize,
    totalChunks: session.totalChunks,
    status: session.status,
    bytesReceived: session.bytesReceived,
    sha256Expected: session.sha256Expected,
    expiresAt: session.expiresAt.toISOString(),
    assetId: session.assetId,
    receivedChunks: [...received].sort((a, b) => a - b),
    missingChunks: missing,
    percent: Math.round((session.bytesReceived / session.declaredSize) * 100)
  };
}

