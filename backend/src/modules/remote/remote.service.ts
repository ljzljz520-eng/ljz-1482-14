import { fileSize } from "../../lib/storage.js";
import { prisma } from "../../lib/prisma.js";
import { AppError, ErrorCodes } from "../../lib/errors.js";
import { childLogger } from "../../lib/logger.js";
import { restrictedDownload } from "../../lib/downloader.js";
import { eventBus } from "../../lib/events.js";
import { registerBlob } from "../assets/blob.service.js";
import { transcodeQueue } from "../assets/worker.service.js";
import { validateInputType } from "../assets/transcode.service.js";
import { guessMime } from "../uploads/upload.service.js";
import { removeFileQuiet } from "../../lib/storage.js";

const log = childLogger("remote-fetch");

function nameFromUrl(url: string, contentType: string): string {
  try {
    const pathname = new URL(url).pathname;
    const base = pathname.split("/").filter(Boolean).pop() ?? "";
    if (base && /\.[a-z0-9]{2,5}$/i.test(base)) return decodeURIComponent(base).slice(0, 180);
  } catch {
    /* ignore */
  }
  const extFromMime: Record<string, string> = {
    "video/mp4": "mp4",
    "video/webm": "webm",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
    "audio/ogg": "ogg",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp"
  };
  const ext = extFromMime[contentType] ?? "bin";
  return `remote-${Date.now()}.${ext}`;
}

export interface FetchInput {
  projectId: number;
  userId: number;
  url: string;
  probeMode: "sync" | "async";
}

/**
 * 远程抓取：所有访问都走受限下载器（SSRF 防护 / 白名单 / 大小控制）。
 * 抓取结果（含拒绝原因、解析 IP、重定向次数）持久记录，供审计与前端定位失败。
 */
export async function createFetch(input: FetchInput) {
  const job = await prisma.remoteFetch.create({
    data: {
      projectId: input.projectId,
      requesterId: input.userId,
      url: input.url,
      status: "pending"
    }
  });

  try {
    await prisma.remoteFetch.update({ where: { id: job.id }, data: { status: "downloading" } });
    eventBus.publish({ type: "fetch", fetchId: job.id, projectId: input.projectId,
      status: "downloading", progress: 0 } as never);

    const result = await restrictedDownload(input.url);

    const contentType = result.contentType;
    const filename = nameFromUrl(result.finalUrl, contentType);
    // 用内容类型/扩展名做媒体类型白名单校验
    validateInputType(filename, contentType);

    await prisma.remoteFetch.update({
      where: { id: job.id },
      data: {
        resolvedIp: result.resolvedIp,
        redirects: result.redirects,
        httpStatus: result.httpStatus,
        contentType,
        sizeBytes: result.sizeBytes
      }
    });

    const actualSize = await fileSize(result.tmpPath);
    const mime = contentType.startsWith("application/octet-stream") ? guessMime(filename) : contentType;
    validateInputType(filename, mime);

    const blob = await registerBlob({
      tmpPath: result.tmpPath,
      sizeBytes: actualSize,
      mimeType: mime
    });

    const mediaType = mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio" : "video";
    const asset = await prisma.asset.create({
      data: {
        projectId: input.projectId,
        uploaderId: input.userId,
        originalBlobId: blob.id,
        filename,
        mediaType,
        status: "received",
        stage: "queued",
        sizeBytes: actualSize,
        source: "remote",
        sourceUrl: result.finalUrl,
        probeMode: input.probeMode
      }
    });

    const completed = await prisma.remoteFetch.update({
      where: { id: job.id },
      data: { status: "completed", assetId: asset.id, completedAt: new Date() }
    });
    eventBus.publish({ type: "fetch", fetchId: job.id, projectId: input.projectId,
      status: "completed", progress: 100, assetId: asset.id } as never);

    if (input.probeMode === "async") {
      transcodeQueue.enqueue({ assetId: asset.id, generation: asset.jobGeneration });
    }
    log.info({ fetchId: job.id, assetId: asset.id, redirects: result.redirects }, "remote fetch completed");
    return { fetch: completed, assetId: asset.id };
  } catch (err) {
    const isBlocked = err instanceof AppError && err.code === ErrorCodes.URL_BLOCKED;
    const tooLarge = err instanceof AppError && err.code === ErrorCodes.REMOTE_TOO_LARGE;
    const status = isBlocked ? "rejected" : tooLarge ? "rejected" : "failed";
    const reasonCode =
      (err instanceof AppError ? (err.details as { reason?: string } | undefined)?.reason : undefined) ??
      (isBlocked ? "url_blocked" : tooLarge ? "too_large" : "fetch_failed");

    const updated = await prisma.remoteFetch.update({
      where: { id: job.id },
      data: {
        status,
        reasonCode,
        errorMessage: (err as Error).message.slice(0, 2000),
        httpStatus: err instanceof AppError ? (err.httpStatus >= 500 ? err.httpStatus : null) : 502,
        completedAt: new Date()
      }
    });
    eventBus.publish({ type: "fetch", fetchId: job.id, projectId: input.projectId,
      status, progress: 0, errorCode: reasonCode, errorMessage: (err as Error).message } as never);
    log.warn({ fetchId: job.id, status, reasonCode }, "remote fetch ended unsuccessfully");
    throw err;
  }
}

export async function listFetches(projectId: number, limit = 30) {
  const jobs = await prisma.remoteFetch.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { asset: { select: { id: true, filename: true, status: true } } }
  });
  return jobs.map((job) => ({
    id: job.id,
    url: job.url,
    status: job.status,
    reasonCode: job.reasonCode,
    errorMessage: job.errorMessage,
    resolvedIp: job.resolvedIp,
    redirects: job.redirects,
    httpStatus: job.httpStatus,
    contentType: job.contentType,
    sizeBytes: job.sizeBytes,
    assetId: job.assetId,
    asset: job.asset,
    createdAt: job.createdAt,
    completedAt: job.completedAt
  }));
}

void removeFileQuiet;
