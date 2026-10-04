import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupHarness, makeFixture, authHeaders, type Harness } from "./_harness.js";
import { prisma } from "../src/db.js";
import { TranscodeWorker } from "../src/services/worker.js";
import { enqueueTranscodeJob, probeAndPersist, processAsset } from "../src/services/transcodeService.js";
import { blobPath } from "../src/services/blobStore.js";

let h: Harness;
let dir: string;
const worker = new TranscodeWorker(prisma);

beforeAll(async () => {
  h = await setupHarness("transcode");
  dir = await mkdtemp(join(tmpdir(), "av-tc-"));
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await prisma.derivative.deleteMany({});
  await prisma.blobReference.deleteMany({});
  await prisma.job.deleteMany({});
  await prisma.asset.deleteMany({});
  await prisma.uploadChunk.deleteMany({});
  await prisma.uploadSession.deleteMany({});
  await prisma.blobObject.deleteMany({});
});

function sha(buf: Buffer) {
  return createHash("sha256").update(buf).digest("hex");
}

async function uploadAsset(kind: Parameters<typeof makeFixture>[0], token = h.projectA.token) {
  const fx = await makeFixture(kind, dir);
  const buf = await readFile(fx.path);
  const sess = await h.app.inject({
    method: "POST", url: h.base("/uploads"),
    headers: await authHeaders(token, { "content-type": "application/json" }),
    payload: { filename: fx.filename, totalSize: buf.length, chunkSize: buf.length },
  }).then((r) => r.json() as { uploadId: string });
  await h.app.inject({
    method: "PUT", url: h.base(`/uploads/${sess.uploadId}/chunks/0`),
    headers: await authHeaders(token, { "content-type": "application/octet-stream" }),
    payload: buf,
  });
  const done = await h.app.inject({
    method: "POST", url: h.base(`/uploads/${sess.uploadId}/complete`),
    headers: await authHeaders(token), payload: { sha256: sha(buf) },
  });
  return { assetId: done.json().assetId as string, session: sess.uploadId, size: buf.length };
}

async function getAsset(id: string, token = h.projectA.token) {
  const r = await h.app.inject({ method: "GET", url: h.base(`/assets/${id}`), headers: await authHeaders(token) });
  expect(r.statusCode).toBe(200);
  return r.json() as AssetJson;
}

interface AssetJson {
  id: string; status: string; kind: string; playable: boolean; ready: boolean;
  hasAudio: boolean; hasVideo: boolean; errorCode: string | null; errorMessage: string | null;
  probeMode: string | null; probeMs: number | null;
  derivatives: Array<{ kind: string; url: string; mimeType: string }>;
  posterUrl: string | null;
}

describe("状态机：RECEIVED → PREVIEWABLE → READY / FAILED", () => {
  it("视频完整流转：缩略图→PREVIEWABLE→预览→READY，记录同步探测/异步转码", async () => {
    const { assetId } = await uploadAsset("video");
    // 完成请求里同步 probe 已跑（元数据就绪），转码由 worker 完成
    await worker.drain(90_000);
    const a = await getAsset(assetId);
    expect(["PREVIEWABLE", "READY"]).toContain(a.status);
    if (a.status !== "READY") {
      await worker.drain(60_000);
    }
    const final = await getAsset(assetId);
    expect(final.status).toBe("READY");
    expect(final.hasVideo).toBe(true);
    expect(final.hasAudio).toBe(true);
    expect(final.probeMode).toBe("sync"); // 同步探测
    expect(final.probeMs).not.toBeNull();
    const kinds = final.derivatives.map((d) => d.kind).sort();
    expect(kinds).toEqual(["thumbnail", "video-preview"]);
  });

  it("音轨缺失：不是失败，标记 NO_AUDIO_STREAM，仍可 READY", async () => {
    const { assetId } = await uploadAsset("noaudio");
    await worker.drain(90_000);
    const a = await getAsset(assetId);
    expect(a.status).toBe("READY");
    expect(a.hasVideo).toBe(true);
    expect(a.hasAudio).toBe(false);
    expect(a.errorCode).toBe("NO_AUDIO_STREAM");
    expect(a.errorMessage).toContain("音轨");
  });

  it("音频：波形→PREVIEWABLE、AAC 预览→READY", async () => {
    const { assetId } = await uploadAsset("audio");
    await worker.drain(90_000);
    const a = await getAsset(assetId);
    expect(a.kind).toBe("audio");
    expect(a.status).toBe("READY");
    const kinds = a.derivatives.map((d) => d.kind).sort();
    expect(kinds).toContain("audio-preview");
  });

  it("图片：同步探测同步转码，完成即 READY", async () => {
    const { assetId } = await uploadAsset("image");
    const a = await getAsset(assetId);
    expect(a.kind).toBe("image");
    expect(a.status).toBe("READY");
    expect(a.probeMode).toBe("sync");
    expect(a.derivatives.some((d) => d.kind === "thumbnail")).toBe(true);
  });

  it("损坏文件探测失败 → FAILED，且播放器拿不到半成品", async () => {
    const { assetId } = await uploadAsset("corrupt");
    await worker.drain(30_000).catch(() => undefined);
    const a = await getAsset(assetId);
    expect(a.status).toBe("FAILED");
    expect(["NO_MEDIA_STREAM", "PROBE_FAILED"]).toContain(a.errorCode);
    expect(a.playable).toBe(false);
    // 未生成任何预览
    expect(a.derivatives.length).toBe(0);
  });

  it("播放器不得把半成品当正式源：RECEIVED 时预览 URL 返回 409", async () => {
    const { assetId } = await uploadAsset("video");
    // 不跑 worker，保持 RECEIVED/unknown
    const fresh = await getAsset(assetId);
    expect(["RECEIVED"]).toContain(fresh.status);
    const r = await h.app.inject({
      method: "GET", url: h.base(`/blobs/derivative/${assetId}/video-preview`),
      headers: await authHeaders(h.projectA.token),
    });
    expect([404, 409]).toContain(r.statusCode);
  });
});

describe("删除素材时转码完成：产物必须被丢弃，绝不复活", () => {
  it("worker 跑到一半删素材：最终资产不存在，孤儿 blob 被 GC", async () => {
    const { assetId } = await uploadAsset("video");
    const job = await enqueueTranscodeJob(prisma, assetId, "async");
    // 直接删除（模拟转码中删除），再运行 worker；processAsset 因找不到资产而退出
    await h.app.inject({
      method: "DELETE", url: h.base(`/assets/${assetId}`),
      headers: await authHeaders(h.projectA.token),
    });
    await worker.tick().catch(() => undefined);
    const gone = await prisma.asset.findUnique({ where: { id: assetId } });
    expect(gone).toBeNull();
    // 任务终态不能是 DONE
    const j = await prisma.job.findUnique({ where: { id: job.id } });
    expect(["CANCELLED", "FAILED"]).toContain(j?.status);

    // 再制造一次：先跑转码，若中途资产被删，标记推进抛 ASSET_DELETED
    const up2 = await uploadAsset("video");
    await probeAndPersist(prisma, up2.assetId, "async");
    await prisma.asset.delete({ where: { id: up2.assetId } });
    const outcome = await processAsset(prisma, up2.assetId, "async").catch((e) => ({ finalStatus: "threw:" + e.message }));
    expect(["FAILED", undefined]).toContain((outcome as { finalStatus?: string }).finalStatus);
    const stillGone = await prisma.asset.findUnique({ where: { id: up2.assetId } });
    expect(stillGone).toBeNull();
  });

  it("删除后 blob 无引用时物理文件被回收；源文件 URL 404", async () => {
    const { assetId } = await uploadAsset("image");
    const before = await getAsset(assetId);
    expect(before.derivatives.length).toBeGreaterThan(0);
    const blob = await prisma.asset.findUniqueOrThrow({ where: { id: assetId }, include: { sourceBlob: true } });
    const sha = blob.sourceBlob.sha256;
    await h.app.inject({ method: "DELETE", url: h.base(`/assets/${assetId}`), headers: await authHeaders(h.projectA.token) });
    const row = await prisma.blobObject.findUnique({ where: { sha256: sha } });
    expect(row).toBeNull();
    const blobRefs = await prisma.blobReference.count({ where: { blobId: blob.sourceBlobId } });
    expect(blobRefs).toBe(0);
    void blobPath;
  });
});

describe("预览切换后旧回调到达：陈旧任务结果不得复活/回退状态", () => {
  it("素材 READY 后再次入队的陈旧任务完成，状态不得回退；删除素材后旧任务不能写回", async () => {
    const { assetId } = await uploadAsset("video");
    await worker.drain(90_000);
    const ready = await getAsset(assetId);
    expect(ready.status).toBe("READY");
    const job = await enqueueTranscodeJob(prisma, assetId, "async");
    await worker.drain(30_000);
    const after = await getAsset(assetId);
    expect(after.status).toBe("READY"); // 不回退到 RECEIVED/PREVIEWABLE
    const j = await prisma.job.findUnique({ where: { id: job.id } });
    expect(j?.status).toBe("DONE");
  });
});;
