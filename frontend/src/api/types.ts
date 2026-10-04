export type AssetStatus = "received" | "previewable" | "ready" | "failed";
export type MediaType = "video" | "audio" | "image";

export interface Rendition {
  id: number;
  kind: "preview" | "cover";
  status: "pending" | "ready" | "failed";
  mimeType: string | null;
  blobId: number | null;
  sizeBytes: number | null;
  errorCode: string | null;
}

export interface Asset {
  id: number;
  projectId: number;
  filename: string;
  mediaType: MediaType;
  status: AssetStatus;
  stage: string;
  progress: number;
  hasAudio: boolean | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  sizeBytes: number;
  source: "upload" | "remote";
  sourceUrl?: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  jobGeneration: number;
  referenceCount: number;
  previewReady: boolean;
  coverReady: boolean;
  createdAt: string;
  updatedAt: string;
  uploader?: { id: number; displayName: string };
  renditions?: Rendition[];
  references?: AssetReference[];
}

export interface AssetReference {
  id: number;
  refType: "scene" | "timeline" | "article";
  refKey: string;
  label: string;
  creator?: { displayName: string };
  asset?: Pick<Asset, "id" | "filename" | "status" | "mediaType">;
}

export interface UploadSession {
  id: number;
  filename: string;
  declaredSize: number;
  chunkSize: number;
  totalChunks: number;
  status: "active" | "completed" | "aborted" | "expired";
  bytesReceived: number;
  sha256Expected?: string | null;
  receivedChunks: number[];
  missingChunks: number[];
  percent: number;
  assetId: number | null;
}

export interface ProjectStats {
  totalAssets: number;
  originalLogicalBytes: number;
  renditionLogicalBytes: number;
  logicalBytes: number;
  physicalBytes: number;
  deduplicatedSavings: number;
  byStatus: Record<string, { count: number; bytes: number }>;
  byMediaType: Record<string, { count: number; bytes: number }>;
  statusCounts: Record<string, number>;
  remoteFetchCount: number;
}

export interface Project {
  id: number;
  key: string;
  name: string;
  role: string;
}

export interface RemoteFetch {
  id: number;
  url: string;
  status: "pending" | "downloading" | "completed" | "rejected" | "failed";
  reasonCode?: string | null;
  errorMessage?: string | null;
  resolvedIp?: string | null;
  redirects: number;
  httpStatus?: number | null;
  contentType?: string | null;
  sizeBytes?: number | null;
  assetId?: number | null;
  asset?: { id: number; filename: string; status: string } | null;
  createdAt: string;
}

