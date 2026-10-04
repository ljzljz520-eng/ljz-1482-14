import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import { requireProject } from "./auth.js";
import { deleteAsset, openBlob } from "../services/assetService.js";

export function serializeAsset(a: {
  id: string;
  filename: string;
  kind: string;
  mimeType: string;
  size: bigint;
  sha256: string;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  probeMode: string | null;
  probeMs: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  createdAt: Date;
  updatedAt: Date;
  derivatives: Array<{ id: string; kind: string; mimeType: string; size: bigint; width: number | null; height: number | null }>;
}) {
  return {
    id: a.id,
    filename: a.filename,
    kind: a.kind,
    mimeType: a.mimeType,
    size: Number(a.size),
    sha256: a.sha256,
    status: a.status,
    errorCode: a.errorCode,
    errorMessage: a.errorMessage,
    probeMode: a.probeMode,
    probeMs: a.probeMs,
    width: a.width,
    height: a.height,
    durationMs: a.durationMs,
    hasVideo: a.hasVideo,
    hasAudio: a.hasAudio,
    // 播放器只能消费状态达标后才生成的预览派生件；RECEIVED/FAILED 不放行
    playable: a.status === "PREVIEWABLE" || a.status === "READY",
    ready: a.status === "READY",
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
    derivatives: a.derivatives.map((d) => ({
      id: d.id,
      kind: d.kind,
      mimeType: d.mimeType,
      size: Number(d.size),
      width: d.width,
      height: d.height,
      url: `/api/blobs/derivative/${a.id}/${d.kind}`,
    })),
    sourceUrl: `/api/blobs/source/${a.id}`,
    posterUrl: a.derivatives.find((d) => d.kind === "thumbnail")
      ? `/api/blobs/derivative/${a.id}/thumbnail`
      : null,
    previewUrl: pickPreview(a.kind, a.status, a.derivatives.map((d) => d.kind)),
  };
}

function pickPreview(kind: string, status: string, kinds: string[]): string | null {
  if (status !== "PREVIEWABLE" && status !== "READY") return null;
  if (kind === "video" && kinds.includes("video-preview")) return "self-video";
  if (kind === "audio" && kinds.includes("audio-preview")) return "self-audio";
  return null;
}

export async function assetRoutes(app: FastifyInstance, opts: { db: Db }) {
  const db = opts.db;

  // 列表（仅当前项目）
  app.get("/assets", async (req) => {
    const project = requireProject(req);
    const query = req.query as { status?: string; kind?: string; q?: string };
    const assets = await db.asset.findMany({
      where: {
        projectId: project.id,
        ...(query.status ? { status: query.status } : {}),
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.q ? { filename: { contains: query.q, mode: "insensitive" as const } } : {}),
      },
      orderBy: { createdAt: "desc" },
      include: { derivatives: true },
      take: 200,
    });
    return { items: assets.map(serializeAsset) };
  });

  // 详情（含转码进度由前端轮询本接口）
  app.get("/assets/:id", async (req, reply) => {
    const project = requireProject(req);
    const { id } = req.params as { id: string };
    const asset = await db.asset.findFirst({
      where: { id, projectId: project.id },
      include: { derivatives: true, jobs: { orderBy: { queuedAt: "desc" }, take: 1 } },
    });
    if (!asset) return reply.code(404).send({ errorCode: "NOT_FOUND", message: "素材不存在或无权访问" });
    const serialized = serializeAsset(asset);
    return {
      ...serialized,
      job: asset.jobs[0]
        ? {
            id: asset.jobs[0].id,
            status: asset.jobs[0].status,
            progress: asset.jobs[0].progress,
            probeMode: asset.jobs[0].probeMode,
            lastError: asset.jobs[0].lastError,
          }
        : null,
    };
  });

  // 删除
  app.delete("/assets/:id", async (req, reply) => {
    const project = requireProject(req);
    const { id } = req.params as { id: string };
    await deleteAsset(db, project.id, id);
    return { ok: true };
  });
}

/** 受限的 blob 下载：源/派生都必须校验项目归属 */
export async function blobRoutes(app: FastifyInstance, opts: { db: Db }) {
  const db = opts.db;

  app.get("/blobs/source/:assetId", async (req, reply) => {
    const project = requireProject(req);
    const { assetId } = req.params as { assetId: string };
    const asset = await db.asset.findFirst({
      where: { id: assetId, projectId: project.id },
      include: { sourceBlob: true },
    });
    if (!asset) return reply.code(404).send({ errorCode: "NOT_FOUND", message: "素材不存在或无权访问" });
    const stream = openBlob(asset.sourceBlob.sha256);
    reply.header("Content-Type", asset.mimeType);
    reply.header("Content-Length", String(asset.sourceBlob.size));
    reply.header(
      "Content-Disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(asset.filename)}`
    );
    reply.header("Cache-Control", "private, max-age=300");
    return reply.send(stream);
  });

  app.get("/blobs/derivative/:assetId/:kind", async (req, reply) => {
    const project = requireProject(req);
    const { assetId, kind } = req.params as { assetId: string; kind: string };
    const allowed = ["video-preview", "audio-preview", "thumbnail", "waveform"];
    if (!allowed.includes(kind)) return reply.code(400).send({ errorCode: "BAD_KIND", message: "未知派生类型" });
    const asset = await db.asset.findFirst({
      where: { id: assetId, projectId: project.id },
      include: { derivatives: { include: { blob: true } } },
    });
    if (!asset) return reply.code(404).send({ errorCode: "NOT_FOUND", message: "素材不存在或无权访问" });
    const derivative = asset.derivatives.find((d) => d.kind === kind);
    if (!derivative) return reply.code(404).send({ errorCode: "NOT_READY", message: "该派生件尚未生成" });
    // 半成品防护：仅当素材状态允许时才输出预览/波形
    if ((kind === "video-preview" || kind === "audio-preview") &&
        asset.status !== "PREVIEWABLE" && asset.status !== "READY") {
      return reply.code(409).send({ errorCode: "NOT_PLAYABLE", message: "素材尚未达到可预览状态" });
    }
    const stream = openBlob(derivative.blob.sha256);
    reply.header("Content-Type", derivative.mimeType);
    reply.header("Content-Length", String(derivative.blob.size));
    reply.header("Cache-Control", "private, max-age=300");
    return reply.send(stream);
  });
}
