import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupHarness, makeFixture, authHeaders, type Harness } from "./_harness.js";
import { prisma } from "../src/db.js";
import { TranscodeWorker } from "../src/services/worker.js";

let h: Harness;
let dir: string;
const worker = new TranscodeWorker(prisma);
beforeAll(async () => {
  h = await setupHarness("stats");
  dir = await mkdtemp(join(tmpdir(), "av-st-"));
});
afterAll(() => h.close());
beforeEach(async () => {
  await prisma.derivative.deleteMany({});
  await prisma.blobReference.deleteMany({});
  await prisma.job.deleteMany({});
  await prisma.asset.deleteMany({});
  await prisma.blobObject.deleteMany({});
});

async function uploadImage(token: string) {
  const fx = await makeFixture("image", dir);
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
  await h.app.inject({
    method: "POST", url: h.base(`/uploads/${sess.uploadId}/complete`),
    headers: await authHeaders(token),
    payload: { sha256: createHash("sha256").update(buf).digest("hex") },
  });
}

it("占用统计：逻辑体积、去重节省、物理占用、状态计数正确", async () => {
  await uploadImage(h.projectA.token);
  await uploadImage(h.projectA.token); // 同字节
  await uploadImage(h.projectB.token); // 跨项目复用
  await worker.drain(15_000).catch(() => undefined);

  const r = await h.app.inject({ method: "GET", url: h.base("/stats"), headers: await authHeaders(h.projectA.token) });
  expect(r.statusCode).toBe(200);
  const s = r.json();
  expect(s.assets.total).toBe(2);
  expect(s.assets.ready).toBe(2);
  expect(s.bytes.logical).toBeGreaterThan(s.bytes.uniqueSource); // 项目内去重节省 > 0
  expect(s.savings.inProjectDedupBytes).toBeGreaterThan(0);
  expect(s.bytes.physicalGlobal).toBeGreaterThan(0);
  expect(s.bytes.quota).toBe(1_000_000_000);
});
