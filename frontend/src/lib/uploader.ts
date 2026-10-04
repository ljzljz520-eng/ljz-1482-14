import {
  completeUpload,
  createUploadSession,
  getUploadSession,
  putChunk
} from "@/api/media";
import { extractApiError } from "@/api/client";
import type { Asset, UploadSession } from "@/api/types";

const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB
const CHUNK_RETRY = 3;

export interface UploadProgress {
  phase: "hashing" | "uploading" | "finalizing" | "done" | "error";
  percent: number;
  uploadedChunks: number;
  totalChunks: number;
  message?: string;
}

export interface UploadOptions {
  projectId: number;
  file: File;
  probeMode: "sync" | "async";
  resumeKey?: string;
  onProgress?: (p: UploadProgress) => void;
  signal?: { aborted: boolean };
}

export async function sha256Hex(data: BufferSource | Blob): Promise<string> {
  if (data instanceof Blob) {
    const buffer = await data.arrayBuffer();
    return hex(await crypto.subtle.digest("SHA-256", buffer));
  }
  return hex(await crypto.subtle.digest("SHA-256", data));
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function resumeStorageKey(projectId: number, key: string) {
  return `park_upload_${projectId}_${key}`;
}

function naturalResumeKey(file: File): string {
  return [file.name, file.size, file.lastModified].map((v) => String(v)).join("::");
}

export interface UploadResult {
  asset: Asset;
  resumed: boolean;
}

/**
 * 分片上传主控：
 *  1. 上传前计算整文件 SHA-256（服务端完成时复核）；
 *  2. 以稳定 clientToken 创建会话，已存在则按服务端返回的已收块范围续传；
 *  3. 仅上传缺失块；每块带 sha256，失败指数退避重试；
 *  4. complete 幂等，网络重试不创建重复素材；
 *  5. 会话 id 持久化到 localStorage，刷新页面后可恢复。
 */
export async function uploadChunked(options: UploadOptions): Promise<UploadResult> {
  const { projectId, file, probeMode, onProgress, signal } = options;
  const key = options.resumeKey ?? naturalResumeKey(file);
  const storageKey = resumeStorageKey(projectId, key);
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

  onProgress?.({ phase: "hashing", percent: 1, uploadedChunks: 0, totalChunks, message: "计算文件校验值" });
  if (signal?.aborted) throw new Error("已取消");
  const fileHash = await sha256Hex(file);
  if (signal?.aborted) throw new Error("已取消");

  // 幂等创建：刷新/重试时返回原会话
  let session: UploadSession;
  try {
    session = await createUploadSession(projectId, {
      clientToken: clientTokenFor(key),
      filename: file.name,
      declaredSize: file.size,
      chunkSize: CHUNK_SIZE,
      sha256Expected: fileHash,
      contentType: file.type || "application/octet-stream"
    });
  } catch (err) {
    throw new Error(extractApiError(err).message ?? "创建上传会话失败");
  }
  localStorage.setItem(storageKey, String(session.id));

  const resumed = session.receivedChunks.length > 0;

  const uploadOne = async (index: number): Promise<void> => {
    const start = index * CHUNK_SIZE;
    const blob = file.slice(start, Math.min(start + CHUNK_SIZE, file.size));
    const checksum = await sha256Hex(blob);
    let lastError: unknown;
    for (let attempt = 1; attempt <= CHUNK_RETRY; attempt += 1) {
      if (signal?.aborted) throw new Error("已取消");
      try {
        session = await putChunk(projectId, session.id, index, blob, checksum);
        return;
      } catch (err) {
        lastError = err;
        const apiError = extractApiError(err);
        if (apiError.code === "CHUNK_CHECKSUM_FAILED" || apiError.code === "CHUNK_MISMATCH") {
          throw new Error(apiError.message ?? `分片 ${index} 校验失败`);
        }
        await new Promise((r) => setTimeout(r, Math.min(1500 * attempt, 4000)));
      }
    }
    throw new Error(extractApiError(lastError).message ?? `分片 ${index} 上传失败`);
  };

  const pending = session.missingChunks.slice().sort((a, b) => a - b);
  let done = session.receivedChunks.length;
  onProgress?.({
    phase: "uploading",
    percent: 10 + Math.round((done / totalChunks) * 75),
    uploadedChunks: done,
    totalChunks,
    message: resumed ? "检测到未完成上传，正在断点续传" : "上传分片"
  });

  for (const index of pending) {
    if (signal?.aborted) throw new Error("已取消");
    await uploadOne(index);
    done += 1;
    onProgress?.({
      phase: "uploading",
      percent: 10 + Math.round((done / totalChunks) * 75),
      uploadedChunks: done,
      totalChunks
    });
  }

  onProgress?.({ phase: "finalizing", percent: 88, uploadedChunks: totalChunks, totalChunks, message: "完成校验并入库" });
  if (signal?.aborted) throw new Error("已取消");

  const result = await completeUpload(projectId, session.id, probeMode);
  onProgress?.({ phase: "done", percent: 100, uploadedChunks: totalChunks, totalChunks });
  localStorage.removeItem(storageKey);
  return { asset: result.asset, resumed };
}

/** 从 localStorage 恢复某文件未完成会话（刷新后重新选择同一文件即可继续）。 */
export async function recoverSession(
  projectId: number,
  file: File
): Promise<{ resumeKey: string; received: number; total: number } | null> {
  const key = naturalResumeKey(file);
  const storageKey = resumeStorageKey(projectId, key);
  const raw = localStorage.getItem(storageKey);
  if (!raw) return null;
  try {
    const session = await getUploadSession(projectId, Number(raw));
    if (session.status !== "active") {
      localStorage.removeItem(storageKey);
      return null;
    }
    return { resumeKey: key, received: session.receivedChunks.length, total: session.totalChunks };
  } catch {
    localStorage.removeItem(storageKey);
    return null;
  }
}

function clientTokenFor(resumeKey: string): string {
  const normalized = resumeKey.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 80);
  return `ul_${normalized}_${hashShort(resumeKey)}`;
}

function hashShort(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex4 = (x: number) => (x >>> 0).toString(16).padStart(8, "0");
  return hex4(h1) + hex4(h2) + hex4(h1 ^ h2) + hex4(h2 ^ h1);
}
