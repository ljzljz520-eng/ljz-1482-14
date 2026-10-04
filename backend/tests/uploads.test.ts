import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
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
  h = await setupHarness("uploads");
  dir = await mkdtemp(join(tmpdir(), "av-up-"));
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

async function initSession(filename: string, totalSize: number, chunkSize: number, checksum?: string) {
  const res = await h.app.inject({
    method: "POST",
    url: h.base("/uploads"),
    headers: await authHeaders(h.projectA.token, { "content-type": "application/json" }),
    payload: { filename, totalSize, chunkSize, sha256: checksum },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { uploadId: string; chunkSize: number; totalChunks: number };
}

async function putChunk(uploadId: string, index: number, body: Buffer, checksum?: string, token = h.projectA.token) {
  return h.app.inject({
    method: "PUT",
    url: h.base(`/uploads/${uploadId}/chunks/${index}`),
    headers: await authHeaders(token, { "content-type": "application/octet-stream", ...(checksum ? { "x-chunk-sha256": checksum } : {}) }),
    payload: body,
  });
}

describe("分片上传：对象身份 + 块范围 + 校验值的中断恢复", () => {
  it("中断后按已收块清单续传，完成后素材可查", async () => {
    const fx = await makeFixture("video", dir);
    const buf = await readFile(fx.path);
    const chunkSize = 100_000;
    const totalChunks = Math.ceil(buf.length / chunkSize);
    const sess = await initSession(fx.filename, buf.length, chunkSize);
    expect(sess.totalChunks).toBe(totalChunks);

    // 只传前两块（模拟中断）
    await putChunk(sess.uploadId, 0, buf.subarray(0, chunkSize));
    await putChunk(sess.uploadId, 1, buf.subarray(chunkSize, 2 * chunkSize));

    // 查询恢复点
    const stateRes = await h.app.inject({
      method: "GET", url: h.base(`/uploads/${sess.uploadId}`),
      headers: await authHeaders(h.projectA.token),
    });
    const state = stateRes.json() as { received: Array<{ index: number }>; status: string };
    expect(state.received.map((r) => r.index).sort()).toEqual([0, 1]);
    expect(state.status).toBe("OPEN");

    // 完成应失败（缺块）
    const incomplete = await h.app.inject({
      method: "POST", url: h.base(`/uploads/${sess.uploadId}/complete`),
      headers: await authHeaders(h.projectA.token), payload: {},
    });
    expect(incomplete.statusCode).toBe(400);

    // 续传剩余块（覆盖断点）
    for (let i = 2; i < totalChunks; i++) {
      await putChunk(sess.uploadId, i, buf.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, buf.length)));
    }

    const done = await h.app.inject({
      method: "POST", url: h.base(`/uploads/${sess.uploadId}/complete`),
      headers: await authHeaders(h.projectA.token),
      payload: { sha256: sha(buf) },
    });
    expect(done.statusCode).toBe(201);
    const body = done.json();
    expect(body.size).toBe(buf.length);
    expect(body.sha256).toBe(sha(buf));
    expect(body.assetId).toBeTruthy();
  });

  it("块校验值错误返回 422 且不写入，正确重传后成功", async () => {
    const fx = await makeFixture("image", dir);
    const buf = await readFile(fx.path);
    const sess = await initSession(fx.filename, buf.length, buf.length);
    const bad = await putChunk(sess.uploadId, 0, buf, "0".repeat(64));
    expect(bad.statusCode).toBe(422);
    expect(bad.json().errorCode).toBe("CHECKSUM_MISMATCH");
    const good = await putChunk(sess.uploadId, 0, buf, sha(buf));
    expect(good.statusCode).toBe(200);
  });

  it("重复 PUT 同一已校验块幂等返回 reused=true", async () => {
    const fx = await makeFixture("image", dir);
    const buf = await readFile(fx.path);
    const sess = await initSession(fx.filename, buf.length, buf.length);
    const first = await putChunk(sess.uploadId, 0, buf, sha(buf));
    const second = await putChunk(sess.uploadId, 0, buf, sha(buf));
    expect(first.json().reused).toBe(false);
    expect(second.json().reused).toBe(true);
  });

  it("完成请求重试不创建重复素材（幂等）", async () => {
    const fx = await makeFixture("audio", dir);
    const buf = await readFile(fx.path);
    const sess = await initSession(fx.filename, buf.length, buf.length);
    await putChunk(sess.uploadId, 0, buf);
    const d1 = await h.app.inject({
      method: "POST", url: h.base(`/uploads/${sess.uploadId}/complete`),
      headers: await authHeaders(h.projectA.token), payload: { sha256: sha(buf) },
    });
    const d2 = await h.app.inject({
      method: "POST", url: h.base(`/uploads/${sess.uploadId}/complete`),
      headers: await authHeaders(h.projectA.token), payload: { sha256: sha(buf) },
    });
    expect(d1.statusCode).toBe(201);
    expect(d2.statusCode).toBe(200);
    expect(d1.json().assetId).toBe(d2.json().assetId);
    expect(d2.json().created).toBe(false);
    const count = await prisma.asset.count({ where: { uploadSessionId: sess.uploadId } });
    expect(count).toBe(1);
  });

  it("整体 sha256 不匹配时拒绝完成（防篡改/字节损坏）", async () => {
    const fx = await makeFixture("image", dir);
    const buf = await readFile(fx.path);
    const sess = await initSession(fx.filename, buf.length, buf.length);
    await putChunk(sess.uploadId, 0, buf);
    const done = await h.app.inject({
      method: "POST", url: h.base(`/uploads/${sess.uploadId}/complete`),
      headers: await authHeaders(h.projectA.token), payload: { sha256: "a".repeat(64) },
    });
    expect([400, 422]).toContain(done.statusCode);
  });

  it("块范围越界被拒（index 超出 totalChunks）", async () => {
    const sess = await initSession("x.mp4", 100, 50);
    const r = await putChunk(sess.uploadId, 5, Buffer.alloc(50));
    expect(r.statusCode).toBe(400);
  });

  it("其他项目不能访问/继续本项目的上传会话", async () => {
    const sess = await initSession("x.mp4", 100, 50);
    const r = await putChunk(sess.uploadId, 0, Buffer.alloc(50), undefined, h.projectB.token);
    expect(r.statusCode).toBe(400); // 会话对 B 不可见
  });
});

describe("恶意超大文件", () => {
  it("初始化时声明超过全局上限 → 413，绝不落盘", async () => {
    const res = await h.app.inject({
      method: "POST", url: h.base("/uploads"),
      headers: await authHeaders(h.projectA.token, { "content-type": "application/json" }),
      payload: { filename: "huge.mp4", totalSize: 100 * 1024 * 1024 * 1024, chunkSize: 4 * 1024 * 1024 },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().errorCode).toBe("FILE_TOO_LARGE");
  });

  it("声明合法但实际块字节超过该块范围 → 413/400 拒绝", async () => {
    const sess = await initSession("sly.mp4", 100, 100);
    const r = await putChunk(sess.uploadId, 0, Buffer.alloc(500));
    expect([400, 413]).toContain(r.statusCode);
  });
});

describe("鉴权", () => {
  it("无令牌 401、错误令牌 401", async () => {
    const r1 = await h.app.inject({ method: "GET", url: h.base("/assets") });
    expect(r1.statusCode).toBe(401);
    const r2 = await h.app.inject({ method: "GET", url: h.base("/assets"), headers: { authorization: "Bearer nope" } });
    expect(r2.statusCode).toBe(401);
  });
});

void createReadStream;
void readFileSync;
void worker;
