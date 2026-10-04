import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { env } from "../config/env.js";
import { childLogger } from "./logger.js";

const log = childLogger("storage");

const ensureDir = (dir: string) => {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
};

ensureDir(env.storageRoot);

export const paths = {
  root: env.storageRoot,
  chunks: path.join(env.storageRoot, "chunks"),
  tmp: path.join(env.storageRoot, "tmp"),
  blobs: path.join(env.storageRoot, "blobs"),
  renditions: path.join(env.storageRoot, "renditions")
};

for (const dir of Object.values(paths)) ensureDir(dir);

/** 物理对象按 sha256 前 4 位分桶，避免单目录文件过多。 */
export function blobPath(sha256: string): string {
  const bucket = sha256.slice(0, 2);
  return path.join(paths.blobs, bucket, sha256);
}

export function renditionPath(assetId: number, kind: string, ext: string): string {
  const dir = path.join(paths.renditions, String(assetId));
  ensureDir(dir);
  return path.join(dir, `${kind}.${ext}`);
}

export function chunkPath(sessionId: number, index: number): string {
  const dir = path.join(paths.chunks, String(sessionId));
  ensureDir(dir);
  return path.join(dir, String(index));
}

export function sessionChunkDir(sessionId: number): string {
  return path.join(paths.chunks, String(sessionId));
}

export function tmpPath(name: string): string {
  return path.join(paths.tmp, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${name}`);
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

export function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function fileSize(filePath: string): Promise<number> {
  return (await stat(filePath)).size;
}

export async function removeFileQuiet(filePath: string): Promise<void> {
  try {
    await rm(filePath, { force: true });
  } catch (err) {
    log.warn({ filePath, err }, "remove file failed (ignored)");
  }
}

export function removeDirQuiet(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    log.warn({ dir, err }, "remove dir failed (ignored)");
  }
}

export async function moveIntoBlobStore(srcPath: string, sha256: string): Promise<string> {
  const target = blobPath(sha256);
  ensureDir(path.dirname(target));
  if (existsSync(target)) {
    await rm(srcPath, { force: true });
    return target;
  }
  try {
    await rename(srcPath, target);
  } catch (err) {
    // EXDEV：源（通常是系统临时目录 /tmp）与 blob 存储不在同一文件系统/挂载点
    // （容器内常见）。回退为同设备安全的“复制再删源”。
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      await pipeline(createReadStream(srcPath), createWriteStream(target));
      await rm(srcPath, { force: true });
    } else {
      throw err;
    }
  }
  return target;
}

export async function writeTmpFile(name: string, buffer: Buffer): Promise<string> {
  const target = tmpPath(name);
  await writeFile(target, buffer);
  return target;
}

export { createReadStream, createWriteStream, renameSync, readFile, rename };
