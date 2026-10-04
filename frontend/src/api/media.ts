import api from "./client";

export type AssetStatus = "RECEIVED" | "PREVIEWABLE" | "READY" | "FAILED" | "unknown";

export interface DerivativeDTO {
  id: string;
  kind: "video-preview" | "audio-preview" | "thumbnail" | "waveform";
  mimeType: string;
  size: number;
  width: number | null;
  height: number | null;
  url: string;
}

export interface AssetDTO {
  id: string;
  filename: string;
  kind: "video" | "audio" | "image" | "unknown";
  mimeType: string;
  size: number;
  sha256: string;
  status: AssetStatus;
  errorCode: string | null;
  errorMessage: string | null;
  probeMode: "sync" | "async" | null;
  probeMs: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  playable: boolean;
  ready: boolean;
  createdAt: string;
  updatedAt: string;
  derivatives: DerivativeDTO[];
  sourceUrl: string;
  posterUrl: string | null;
  previewUrl: string | null;
  job?: {
    id: string;
    status: "QUEUED" | "RUNNING" | "DONE" | "FAILED" | "CANCELLED";
    progress: number;
    probeMode: "sync" | "async";
    lastError: string | null;
  } | null;
}

export interface StatsDTO {
  project: { id: string; name: string; code: string; quotaBytes: number };
  assets: { total: number; received: number; previewable: number; ready: number; failed: number; unknown: number };
  jobsRunning: number;
  bytes: { logical: number; uniqueSource: number; derivatives: number; physicalGlobal: number; quota: number };
  savings: { inProjectDedupBytes: number };
}

export interface UploadInit {
  uploadId: string;
  chunkSize: number;
  totalChunks: number;
  totalSize: number;
}

export interface UploadState {
  uploadId: string;
  filename: string;
  totalSize: number;
  chunkSize: number;
  totalChunks: number;
  status: "OPEN" | "COMPLETED" | "ABORTED";
  assetId: string | null;
  received: Array<{ index: number; offset: number; size: number; sha256: string }>;
}

export interface MeDTO {
  project: { id: string; code: string; name: string };
}

export const mediaApi = {
  me: () => api.get<MeDTO>("/me").then((r) => r.data),
  stats: () => api.get<StatsDTO>("/stats").then((r) => r.data),
  list: (params?: { status?: string; kind?: string }) =>
    api.get<{ items: AssetDTO[] }>("/assets", { params }).then((r) => r.data.items),
  get: (id: string) => api.get<AssetDTO>(`/assets/${id}`).then((r) => r.data),
  remove: (id: string) => api.delete(`/assets/${id}`).then((r) => r.data),
  initUpload: (body: { filename: string; totalSize: number; chunkSize: number; sha256?: string }) =>
    api.post<UploadInit>("/uploads", body).then((r) => r.data),
  getUpload: (uploadId: string) => api.get<UploadState>(`/uploads/${uploadId}`).then((r) => r.data),
  abortUpload: (uploadId: string) => api.delete(`/uploads/${uploadId}`).then((r) => r.data),
  complete: (uploadId: string, sha256?: string) =>
    api
      .post<{ ok: boolean; created: boolean; assetId: string; sha256: string; size: number; blobReused: boolean; probe: "sync" | "async"; asset: AssetDTO | null }>(
        `/uploads/${uploadId}/complete`,
        { sha256 }
      )
      .then((r) => r.data),
  remoteImport: (url: string, filename?: string) =>
    api
      .post<{ assetId: string; asset: AssetDTO | null; sha256: string; size: number }>("/remote-import", { url, filename })
      .then((r) => r.data),
};
