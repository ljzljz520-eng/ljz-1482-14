import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import type { Db } from "../db.js";
import { requireProject } from "./auth.js";
import {
  ChecksumMismatchError,
  PayloadTooLargeError,
  commitStream,
} from "../services/blobStore.js";
import {
  completeUpload,
  createUploadSession,
  abortSession,
  listReceived,
  putChunk,
  ValidationError,
} from "../services/uploadService.js";
import {
  enqueueTranscodeJob,
  probeAndPersist,
  processAsset,
} from "../services/transcodeService.js";
import { serializeAsset } from "./assets.js";
import { RemoteFetchError, openRemoteStream, preflight } from "../services/remoteFetcher.js";
import { registerIngestedBlob } from "../services/assetService.js";

const initSchema = z.object({
  filename: z.string().min(1).max(255),
  totalSize: z.number().int().positive(),
  chunkSize: z.number().int().min(1).max(64 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

export async function uploadRoutes(app: FastifyInstance, opts: { db: Db }) {
  const db = opts.db;

  // 初始化分片上传（对象身份 uploadId）
  app.post("/uploads", async (req, reply) => {
    const project = requireProject(req);
    const parsed = initSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ errorCode: "VALIDATION", message: parsed.error.issues[0]?.message });
    }
    try {
      const session = await createUploadSession(db, project.id, parsed.data);
      return reply.code(201).send({
        uploadId: session.id,
        chunkSize: session.chunkSize,
        totalChunks: session.totalChunks,
        totalSize: Number(session.totalSize),
      });
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        return reply.code(413).send({ errorCode: "FILE_TOO_LARGE", message: err.message, limitBytes: err.limitBytes });
      }
      throw err;
    }
  });

  // 已收分片清单（断点恢复）
  app.get("/uploads/:id", async (req, reply) => {
    const project = requireProject(req);
    const { id } = req.params as { id: string };
    const state = await listReceived(db, project.id, id);
    if (!state) return reply.code(404).send({ errorCode: "NOT_FOUND", message: "上传会话不存在或无权访问" });
    return state;
  });

  app.delete("/uploads/:id", async (req, reply) => {
    const project = requireProject(req);
    const { id } = req.params as { id: string };
    const ok = await abortSession(db, project.id, id);
    return reply.code(ok ? 200 : 404).send({ ok });
  });

  // 上传单块：原始字节流；块范围由路径决定；校验值可由 X-Chunk-Sha256 携带
  app.put("/uploads/:id/chunks/:index", async (req, reply) => {
    const project = requireProject(req);
    const { id, index: indexRaw } = req.params as { id: string; index: string };
    const index = Number(indexRaw);
    const clientSha256 = (req.headers["x-chunk-sha256"] as string | undefined)?.toLowerCase();
    try {
      const result = await putChunk({
        db,
        projectId: project.id,
        uploadId: id,
        index,
        stream: req.raw,
        clientSha256,
      });
      return reply.send(result);
    } catch (err) {
      if (err instanceof ValidationError) {
        return reply.code(400).send({ errorCode: "VALIDATION", message: err.message });
      }
      if (err instanceof ChecksumMismatchError) {
        return reply.code(422).send({ errorCode: "CHECKSUM_MISMATCH", message: err.message, expected: err.expected, actual: err.actual });
      }
      if (err instanceof PayloadTooLargeError) {
        return reply.code(413).send({ errorCode: "CHUNK_TOO_LARGE", message: err.message, limitBytes: err.limitBytes });
      }
      throw err;
    }
  });

  // 完成（幂等：重试返回同一 assetId，绝不创建重复素材）
  app.post("/uploads/:id/complete", async (req, reply) => {
    const project = requireProject(req);
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { sha256?: string };
    try {
      const result = await completeUpload(db, project.id, id, body.sha256?.toLowerCase());

      // 同步探测 vs 异步探测（共用同一状态机）：
      // 1) 先在 SYNC_PROBE_MS 预算内同步 ffprobe；
      // 2) 同步拿到元数据 → 图片这种轻素材请求内转完到 READY；
      //    视频/音频转码耗时不可控，立即入队由 worker 异步处理；
      // 3) 同步探测超时（大文件/容器慢）→ 不判失败，保持 RECEIVED 并异步接管。
      let probeMode: "sync" | "async" = "async";
      if (result.created) {
        const probed = await probeAndPersist(db, result.assetId, "sync", config.SYNC_PROBE_MS);
        if (probed.ok) {
          probeMode = "sync";
          if (probed.meta.kind === "image") {
            await processAsset(db, result.assetId, "sync", { probeTimeoutMs: config.SYNC_PROBE_MS });
          } else {
            await enqueueTranscodeJob(db, result.assetId, "async");
          }
        } else if (probed.timeout) {
          probeMode = "async";
          await enqueueTranscodeJob(db, result.assetId, "async");
        } else {
          probeMode = "sync"; // 探测真实失败（坏文件），状态已置 FAILED
        }
      } else {
        const existing = await db.asset.findUnique({ where: { id: result.assetId } });
        probeMode = (existing?.probeMode as "sync" | "async" | null) ?? "sync";
      }

      const fresh = await db.asset.findUnique({ where: { id: result.assetId }, include: { derivatives: true } });
      return reply.status(result.created ? 201 : 200).send({
        ok: true,
        created: result.created,
        assetId: result.assetId,
        sha256: result.sha256,
        size: result.size,
        blobReused: result.blobReused,
        probe: probeMode,
        asset: fresh ? serializeAsset(fresh) : null,
      });
    } catch (err) {
      if (err instanceof ValidationError) {
        return reply.code(400).send({ errorCode: "VALIDATION", message: err.message });
      }
      if (err instanceof ChecksumMismatchError) {
        return reply.code(422).send({ errorCode: "CHECKSUM_MISMATCH", message: err.message });
      }
      throw err;
    }
  });

  // 远程链接导入：受限下载器拉取，禁止把任意 URL 当读取本地/内网资源的入口
  app.post("/remote-import", async (req, reply) => {
    const project = requireProject(req);
    const schema = z.object({
      url: z.string().url().max(2048),
      filename: z.string().min(1).max(255).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ errorCode: "VALIDATION", message: parsed.error.issues[0]?.message });
    }
    try {
      await preflight(parsed.data.url);
      const opened = await openRemoteStream(parsed.data.url);
      const committed = await commitStream(opened.stream);
      if (committed.size > config.MAX_REMOTE_BYTES) {
        return reply.code(413).send({ errorCode: "REMOTE_TOO_LARGE", message: "远程文件超过下载上限" });
      }
      const filename = parsed.data.filename ?? filenameFromUrl(opened.finalUrl, opened.contentType);
      const registered = await registerIngestedBlob({
        db,
        projectId: project.id,
        filename,
        sha256: committed.sha256,
        size: committed.size,
        mimeType: opened.contentType ?? "application/octet-stream",
      });

      // 与上传完成相同的探测策略
      const probed = await probeAndPersist(db, registered.assetId, "sync", config.SYNC_PROBE_MS);
      if (probed.ok && probed.meta.kind === "image") {
        await processAsset(db, registered.assetId, "sync", { probeTimeoutMs: config.SYNC_PROBE_MS });
      } else {
        await enqueueTranscodeJob(db, registered.assetId, "async");
      }

      const asset = await db.asset.findUnique({ where: { id: registered.assetId }, include: { derivatives: true } });
      return reply.code(201).send({
        ok: true,
        created: registered.created,
        assetId: registered.assetId,
        sha256: committed.sha256,
        size: committed.size,
        blobReused: committed.reused,
        sourceUrl: opened.finalUrl,
        asset: asset ? serializeAsset(asset) : null,
      });
    } catch (err) {
      if (err instanceof RemoteFetchError) {
        const status =
          err.code === "REMOTE_TOO_LARGE" ? 413 :
          err.code === "URL_INVALID" ? 400 : 422;
        return reply.code(status).send({ errorCode: err.code, message: err.message, meta: err.meta });
      }
      if (err instanceof PayloadTooLargeError) {
        return reply.code(413).send({ errorCode: "REMOTE_TOO_LARGE", message: err.message, limitBytes: err.limitBytes });
      }
      throw err;
    }
  });
}

function filenameFromUrl(url: string, contentType: string | null): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    if (last && /\.[a-z0-9]{2,5}$/i.test(last)) return decodeURIComponent(last);
  } catch {
    /* ignore */
  }
  const ext = contentType?.includes("png") ? "png"
    : contentType?.includes("jpeg") || contentType?.includes("jpg") ? "jpg"
    : contentType?.includes("webp") ? "webp"
    : contentType?.includes("mp4") ? "mp4"
    : "bin";
  return `remote-${Date.now()}.${ext}`;
}

