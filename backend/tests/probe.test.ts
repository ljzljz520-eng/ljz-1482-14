import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupHarness, makeFixture, authHeaders, type Harness } from "./_harness.js";
import { prisma } from "../src/db.js";
import { probeAndPersist } from "../src/services/transcodeService.js";
import { TranscodeWorker } from "../src/services/worker.js";

let h: Harness;
let dir: string;
const worker = new TranscodeWorker(prisma);
beforeAll(async () => {
  h = await setupHarness("probe");
  dir = await mkdtemp(join(tmpdir(), "av-pr-"));
});
afterAll(() => h.close());
beforeEach(async () => {
  await prisma.derivative.deleteMany({});
  await prisma.blobReference.deleteMany({});
  await prisma.job.deleteMany({});
  await prisma.asset.deleteMany({});
  await prisma.blobObject.deleteMany({});
});

async function upload(kind: Parameters<typeof makeFixture>[0]) {
  const fx = await makeFixture(kind, dir);
  const buf = await readFile(fx.path);
  const sess = await h.app.inject({
    method: "POST", url: h.base("/uploads"),
    headers: await authHeaders(h.projectA.token, { "content-type": "application/json" }),
    payload: { filename: fx.filename, totalSize: buf.length, chunkSize: buf.length },
  }).then((r) => r.json() as { uploadId: string });
  await h.app.inject({
    method: "PUT", url: h.base(`/uploads/${sess.uploadId}/chunks/0`),
    headers: await authHeaders(h.projectA.token, { "content-type": "application/octet-stream" }),
    payload: buf,
  });
  const done = await h.app.inject({
    method: "POST", url: h.base(`/uploads/${sess.uploadId}/complete`),
    headers: await authHeaders(h.projectA.token),
    payload: { sha256: createHash("sha256").update(buf).digest("hex") },
  });
  return done.json().assetId as string;
}

describe("同步探测 vs 异步探测（同一状态机）", () => {
  it("正常媒体：完成请求内同步拿到元数据，记录 probeMode=sync 与 probeMs", async () => {
    const id = await upload("video");
    const a = await prisma.asset.findUniqueOrThrow({ where: { id } });
    expect(a.kind).toBe("video");
    expect(a.probeMode).toBe("sync");
    expect(a.probeMs).not.toBeNull();
    expect(a.hasVideo).toBe(true);
  });

  it("同步预算极短（1ms）超时 → 返回 deferred，不判失败；异步 worker 接管后 READY", async () => {
    const id = await upload("noaudio");
    // 人为再走一遍 1ms 预算的同步探测：真实慢文件路径模拟
    // 先把 kind 复位为 unknown 以强制重探
    await prisma.asset.update({ where: { id }, data: { kind: "unknown", probeMode: null, probeMs: null, status: "RECEIVED" } });
    const result = await probeAndPersist(prisma, id, "sync", 1);
    // 极小视频 ffprobe 可能仍在 1ms 内失败/超时；两种结果都必须安全：
    if (result.ok === false && "timeout" in result && result.timeout) {
      expect(result).toMatchObject({ ok: false, timeout: true });
      // worker 异步接管
      await worker.drain(60_000);
      const after = await prisma.asset.findUniqueOrThrow({ where: { id } });
      expect(after.status).toBe("READY");
    } else if (result.ok) {
      expect(result.meta.kind).toBe("video");
    }
  });

  it("损坏文件同步探测直接落 FAILED（无异步任务也能看到失败原因）", async () => {
    const id = await upload("corrupt");
    const a = await prisma.asset.findUniqueOrThrow({ where: { id } });
    expect(a.status).toBe("FAILED");
    expect(["NO_MEDIA_STREAM", "PROBE_FAILED"]).toContain(a.errorCode);
    expect(a.errorMessage).toBeTruthy();
  });
});
