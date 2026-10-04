import { createHash, randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { createReadStream, createWriteStream, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { rm } from "node:fs/promises";
import type { Readable } from "node:stream";
import { config } from "../config.js";

export const STORAGE_DIR = config.STORAGE_DIR;
export const CHUNK_DIR = join(STORAGE_DIR, "chunks");
export const BLOB_DIR = join(STORAGE_DIR, "blobs");
export const TMP_DIR = join(STORAGE_DIR, "tmp");

for (const d of [CHUNK_DIR, BLOB_DIR, TMP_DIR]) {
  mkdirSync(d, { recursive: true });
}

export class ChecksumMismatchError extends Error {
  constructor(
    public expected: string,
    public actual: string
  ) {
    super(`校验值不匹配: expected=${expected} actual=${actual}`);
    this.name = "ChecksumMismatchError";
  }
}

export class PayloadTooLargeError extends Error {
  constructor(
    public limitBytes: number,
    public actualBytes?: number
  ) {
    super(`负载超过大小上限 ${limitBytes} 字节`);
    this.name = "PayloadTooLargeError";
  }
}

/** 内容寻址路径：按 sha256 前两位分桶，避免单目录文件过多 */
export function blobPath(sha256: string): string {
  return join(BLOB_DIR, sha256.slice(0, 2), sha256);
}

export function blobDiskExists(sha256: string): boolean {
  try {
    statSync(blobPath(sha256));
    return true;
  } catch {
    return false;
  }
}

/**
 * 把一段流原子地写入 blob 存储；按 sha256 内容寻址。
 * 内容相同的字节只落盘一份；expectedSha256 用于完成时强校验。
 */
export async function commitStream(
  stream: Readable,
  expectedSha256?: string
): Promise<{ sha256: string; size: number; reused: boolean }> {
  const tmp = join(TMP_DIR, `${Date.now()}-${randomUUID()}`);
  const out = createWriteStream(tmp);
  const hash = createHash("sha256");
  let size = 0;
  await pipeline(
    stream,
    async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        hash.update(chunk);
        size += chunk.length;
        yield chunk;
      }
    },
    out
  );
  const sha256 = hash.digest("hex");
  if (expectedSha256 && expectedSha256 !== sha256) {
    await unlink(tmp).catch(() => undefined);
    throw new ChecksumMismatchError(expectedSha256, sha256);
  }
  const dest = blobPath(sha256);
  if (blobDiskExists(sha256)) {
    await unlink(tmp).catch(() => undefined);
    return { sha256, size, reused: true };
  }
  await import("node:fs/promises").then((fsp) =>
    fsp.mkdir(dirname(dest), { recursive: true })
  );
  await import("node:fs/promises").then((fsp) => fsp.rename(tmp, dest));
  return { sha256, size, reused: false };
}

/** 把本地文件注册进 blob 存储（转码产物使用），同样按内容去重 */
export async function commitLocalFile(
  localPath: string,
  expectedSha256?: string
): Promise<{ sha256: string; size: number; reused: boolean }> {
  return commitStream(createReadStream(localPath), expectedSha256);
}

// ---------------------------------------------------------------------------
// 分片存储：块以「对象身份 uploadId + 块范围 index」定位，内容以 sha256 校验
// ---------------------------------------------------------------------------
export function chunkPath(uploadId: string, index: number): string {
  return join(CHUNK_DIR, uploadId, String(index).padStart(8, "0"));
}

export async function writeChunk(
  uploadId: string,
  index: number,
  stream: Readable,
  expectedSha256: string | undefined,
  maxSize: number
): Promise<{ sha256: string; size: number }> {
  const dir = join(CHUNK_DIR, uploadId);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  const dest = chunkPath(uploadId, index);
  const out = createWriteStream(dest);
  const hash = createHash("sha256");
  let size = 0;
  try {
    await pipeline(
      stream,
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          size += chunk.length;
          if (size > maxSize) {
            throw new PayloadTooLargeError(maxSize, size);
          }
          hash.update(chunk);
          yield chunk;
        }
      },
      out
    );
  } catch (err) {
    await unlink(dest).catch(() => undefined);
    throw err;
  }
  const sha256 = hash.digest("hex");
  if (expectedSha256 && expectedSha256 !== sha256) {
    await unlink(dest).catch(() => undefined);
    throw new ChecksumMismatchError(expectedSha256, sha256);
  }
  return { sha256, size };
}

/** 顺序读取已收齐的块 */
export function* readChunks(uploadId: string, totalChunks: number): Generator<Readable> {
  for (let i = 0; i < totalChunks; i++) {
    yield createReadStream(chunkPath(uploadId, i));
  }
}

export async function removeChunks(uploadId: string): Promise<void> {
  await rm(join(CHUNK_DIR, uploadId), { recursive: true, force: true });
}

export async function removeBlob(sha256: string): Promise<void> {
  await unlink(blobPath(sha256)).catch(() => undefined);
}
