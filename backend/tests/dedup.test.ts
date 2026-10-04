import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupHarness, makeFixture, authHeaders, type Harness } from "./_harness.js";
import { prisma } from "../src/db.js";

let h: Harness;
let dir: string;
beforeAll(async () => {
  h = await setupHarness("dedup");
  dir = await mkdtemp(join(tmpdir(), "av-dd-"));
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

async function uploadBytes(filename: string, buf: Buffer, token: string) {
  const sess = await h.app.inject({
    method: "POST", url: h.base("/uploads"),
    headers: await authHeaders(token, { "content-type": "application/json" }),
    payload: { filename, totalSize: buf.length, chunkSize: buf.length },
  }).then((r) => r.json() as { uploadId: string });
  await h.app.inject({
    method: "PUT", url: h.base(`/uploads/${sess.uploadId}/chunks/0`),
    headers: await authHeaders(token, { "content-type": "application/octet-stream" }),
    payload: buf,
  });
  const done = await h.app.inject({
    method: "POST", url: h.base(`/uploads/${sess.uploadId}/complete`),
    headers: await authHeaders(token),
    payload: { sha256: createHash("sha256").update(buf).digest("hex") },
  });
  return done.json() as { assetId: string; blobReused: boolean; created: boolean };
}

describe("内容相同复用字节，但授权与项目归属不随去重共享", () => {
  it("同项目同字节：blob 行复用；项目内出现两条素材记录", async () => {
    const fx = await makeFixture("image", dir);
    const buf = await readFile(fx.path);
    const r1 = await uploadBytes("a.png", buf, h.projectA.token);
    const r2 = await uploadBytes("a-copy.png", buf, h.projectA.token);
    expect(r1.assetId).not.toBe(r2.assetId); // 不同素材
    const blobs = await prisma.blobObject.count({ where: { sha256: createHash("sha256").update(buf).digest("hex") } });
    expect(blobs).toBe(1); // 字节只存一份
    const refs = await prisma.blobReference.count({ where: { kind: "source" } });
    expect(refs).toBe(2);
  });

  it("跨项目：物理字节复用，但素材互不可见、引用各自独立", async () => {
    const fx = await makeFixture("image", dir);
    const buf = await readFile(fx.path);
    const rA = await uploadBytes("shared.png", buf, h.projectA.token);
    const rB = await uploadBytes("shared.png", buf, h.projectB.token);
    expect(rA.assetId).not.toBe(rB.assetId);
    const blob = await prisma.blobObject.findUniqueOrThrow({ where: { sha256: createHash("sha256").update(buf).digest("hex") } });
    expect(blob.refCount).toBe(2);

    // B 看不到 A 的素材
    const cross = await h.app.inject({ method: "GET", url: h.base(`/assets/${rA.assetId}`), headers: await authHeaders(h.projectB.token) });
    expect(cross.statusCode).toBe(404);
    // B 无法下载 A 的源
    const src = await h.app.inject({ method: "GET", url: h.base(`/blobs/source/${rA.assetId}`), headers: await authHeaders(h.projectB.token) });
    expect(src.statusCode).toBe(404);
    // A 自己可访问
    const own = await h.app.inject({ method: "GET", url: h.base(`/blobs/source/${rA.assetId}`), headers: await authHeaders(h.projectA.token) });
    expect(own.statusCode).toBe(200);
  });

  it("一个项目删除素材后，另一项目仍可访问（GC 只在引用归零时回收）", async () => {
    const fx = await makeFixture("image", dir);
    const buf = await readFile(fx.path);
    const rA = await uploadBytes("keep.png", buf, h.projectA.token);
    const rB = await uploadBytes("keep.png", buf, h.projectB.token);
    await h.app.inject({ method: "DELETE", url: h.base(`/assets/${rA.assetId}`), headers: await authHeaders(h.projectA.token) });
    // blob 仍在
    const blob = await prisma.blobObject.findUnique({ where: { sha256: createHash("sha256").update(buf).digest("hex") } });
    expect(blob).not.toBeNull();
    // B 仍可下载
    const src = await h.app.inject({ method: "GET", url: h.base(`/blobs/source/${rB.assetId}`), headers: await authHeaders(h.projectB.token) });
    expect(src.statusCode).toBe(200);
  });
});
