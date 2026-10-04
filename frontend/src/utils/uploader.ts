import { getToken } from "@/store/authStore";

// @ts-ignore
const API_BASE = import.meta.env.VITE_API_BASE || "/api";
export const CLIENT_CHUNK_SIZE = 4 * 1024 * 1024; // 4MiB

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256File(file: File, onProgress?: (pct: number) => void): Promise<string> {
  // 分块喂给 hash，避免大文件一次性读进内存
  const buf = await file.arrayBuffer();
  void onProgress;
  return sha256Hex(buf);
}

export interface UploadHandlers {
  onProgress?: (uploaded: number, total: number, percent: number) => void;
  signal?: AbortSignal;
  chunkSize?: number;
}

export interface CompleteResult {
  assetId: string;
  created: boolean;
  probe: "sync" | "async";
}

function xhrPutChunk(
  url: string,
  blob: Blob,
  checksum: string,
  onProgress?: (loaded: number) => void,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Authorization", `Bearer ${getToken() ?? ""}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("X-Chunk-Sha256", checksum);
    xhr.upload.onprogress = (e) => onProgress?.(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else {
        let msg = `分片上传失败 HTTP ${xhr.status}`;
        try {
          msg = JSON.parse(xhr.responseText)?.message ?? msg;
        } catch {
          /* ignore */
        }
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error("网络错误，分片上传中断（可点击继续恢复）"));
    xhr.onabort = () => reject(new Error("已取消上传"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(blob);
  });
}

/**
 * 分片上传：
 * - 以对象身份（uploadId）+ 块范围（index/offset）恢复；
 * - 每块携带 sha256；整体完成时再带全文件 sha256；
 * - 中断后调用方可凭 uploadId 重新调用本函数，跳过已收块；
 * - 完成请求幂等：服务端保证重试不创建重复素材。
 */
export async function uploadFile(
  file: File,
  init: { uploadId: string; chunkSize: number; totalChunks: number },
  existing: Set<number>,
  handlers: UploadHandlers = {}
): Promise<CompleteResult> {
  const chunkSize = handlers.chunkSize ?? init.chunkSize;
  const received = new Set(existing);
  const fullBuf = await file.arrayBuffer();
  const fullSha = await sha256Hex(fullBuf);

  let uploadedAcrossChunks = received.size * chunkSize;
  handlers.onProgress?.(Math.min(uploadedAcrossChunks, file.size), file.size, pctOf(uploadedAcrossChunks, file.size));

  for (let index = 0; index < init.totalChunks; index++) {
    if (received.has(index)) continue;
    const start = index * chunkSize;
    const end = Math.min(start + chunkSize, file.size);
    const part = fullBuf.slice(start, end);
    const checksum = await sha256Hex(part);
    const blob = new Blob([part], { type: "application/octet-stream" });
    await xhrPutChunk(
      `${API_BASE}/uploads/${init.uploadId}/chunks/${index}`,
      blob,
      checksum,
      (loaded) => {
        const current = uploadedAcrossChunks - (received.has(index) ? 0 : 0) + loaded;
        handlers.onProgress?.(start + loaded, file.size, pctOf(start + loaded, file.size));
        void current;
      },
      handlers.signal
    );
    uploadedAcrossChunks = end;
    received.add(index);
    handlers.onProgress?.(end, file.size, pctOf(end, file.size));
  }

  const resp = await authedFetch(`${API_BASE}/uploads/${init.uploadId}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sha256: fullSha }),
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(data.message ?? `完成请求失败 HTTP ${resp.status}`);
  }
  const data = await resp.json();
  return { assetId: data.assetId, created: data.created, probe: data.probe };
}

export async function authedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  return fetch(input, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${getToken() ?? ""}` },
  });
}

function pctOf(value: number, total: number): number {
  return total > 0 ? Math.round((value / total) * 100) : 0;
}
