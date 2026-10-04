import { api, API_BASE, authHeaders } from "./client";
import type { Asset, Project, ProjectStats, RemoteFetch, UploadSession } from "./types";

export async function listProjects(): Promise<Project[]> {
  const { data } = await api.get<{ projects: Project[] }>("/projects");
  return data.projects;
}

export interface ListAssetsParams {
  status?: string;
  mediaType?: string;
  keyword?: string;
  page?: number;
  pageSize?: number;
}

export async function listAssets(projectId: number, params: ListAssetsParams = {}) {
  const { data } = await api.get<{ items: Asset[]; total: number; page: number; pageSize: number }>(
    `/projects/${projectId}/assets`,
    { params }
  );
  return data;
}

export async function getAsset(projectId: number, assetId: number): Promise<Asset> {
  const { data } = await api.get<{ asset: Asset }>(`/projects/${projectId}/assets/${assetId}`);
  return data.asset;
}

export async function deleteAsset(projectId: number, assetId: number) {
  await api.delete(`/projects/${projectId}/assets/${assetId}`);
}

export async function retryTranscode(
  projectId: number,
  assetId: number,
  probeMode: "sync" | "async" = "async"
) {
  const { data } = await api.post<{ asset: Asset }>(
    `/projects/${projectId}/assets/${assetId}/retry`,
    { probeMode }
  );
  return data.asset;
}

export async function getStats(projectId: number): Promise<ProjectStats> {
  const { data } = await api.get<{ stats: ProjectStats }>(`/projects/${projectId}/stats`);
  return data.stats;
}

export async function listFetches(projectId: number): Promise<RemoteFetch[]> {
  const { data } = await api.get<{ fetches: RemoteFetch[] }>(
    `/projects/${projectId}/remote-fetches`
  );
  return data.fetches;
}

export async function createFetch(projectId: number, url: string, probeMode: "sync" | "async") {
  const { data } = await api.post<{ asset: Asset }>(
    `/projects/${projectId}/remote-fetches`,
    { url, probeMode },
    { timeout: probeMode === "sync" ? 180_000 : 30_000 }
  );
  return data.asset;
}

export interface CreateSessionBody {
  clientToken: string;
  filename: string;
  declaredSize: number;
  chunkSize: number;
  sha256Expected?: string | null;
  contentType?: string | null;
}

export async function createUploadSession(
  projectId: number,
  body: CreateSessionBody
): Promise<UploadSession> {
  const { data } = await api.post<{ session: UploadSession }>(
    `/projects/${projectId}/sessions`,
    body
  );
  return data.session;
}

export async function getUploadSession(projectId: number, sessionId: number): Promise<UploadSession> {
  const { data } = await api.get<{ session: UploadSession }>(
    `/projects/${projectId}/sessions/${sessionId}`
  );
  return data.session;
}

export async function putChunk(
  projectId: number,
  sessionId: number,
  index: number,
  blob: Blob,
  checksum: string
) {
  const { data } = await api.put<{ session: UploadSession }>(
    `/projects/${projectId}/sessions/${sessionId}/chunks/${index}`,
    blob,
    {
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Chunk-Sha256": checksum
      },
      timeout: 180_000
    }
  );
  return data.session;
}

export async function completeUpload(
  projectId: number,
  sessionId: number,
  probeMode: "sync" | "async"
): Promise<{ asset: Asset; alreadyExisted: boolean }> {
  const { data } = await api.post<{ asset: Asset; alreadyExisted: boolean }>(
    `/projects/${projectId}/sessions/${sessionId}/complete`,
    { probeMode },
    { timeout: probeMode === "sync" ? 180_000 : 30_000 }
  );
  return data;
}

export function streamUrl(projectId: number, assetId: number, target: "original" | "preview" | "cover") {
  return `${API_BASE}/projects/${projectId}/assets/${assetId}/stream/${target}`;
}

export function streamHeaders() {
  return authHeaders();
}
