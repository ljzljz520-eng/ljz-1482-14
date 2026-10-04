import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupHarness, makeFixture, authHeaders, type Harness } from "./_harness.js";
import { prisma } from "../src/db.js";
import {
  RemoteFetchError,
  openRemoteStream,
  parseAllowedUrl,
} from "../src/services/remoteFetcher.js";
import { TranscodeWorker } from "../src/services/worker.js";

let h: Harness;
let dir: string;
const worker = new TranscodeWorker(prisma);

let server: http.Server;
let serverUrl: string;

beforeAll(async () => {
  h = await setupHarness("remote");
  dir = await mkdtemp(join(tmpdir(), "av-rm-"));

  // 本地测试服务器：模拟白名单主机、重定向、超大响应、内网跳转
  await new Promise<void>((resolve) => {
    server = http.createServer((req, res) => {
      const u = req.url ?? "/";
      if (u.startsWith("/redirect-internal")) {
        res.writeHead(302, { Location: "http://127.0.0.1:nope/x" });
        res.end();
      } else if (u.startsWith("/redirect-file")) {
        res.writeHead(302, { Location: "file:///etc/passwd" });
        res.end();
      } else if (u.startsWith("/redirect-ok")) {
        res.writeHead(302, { Location: "/media" });
        res.end();
      } else if (u.startsWith("/huge")) {
        res.writeHead(200, { "Content-Type": "video/mp4" });
        const buf = Buffer.alloc(1024 * 1024, 0x61);
        let i = 0;
        const iv = setInterval(() => {
          res.write(buf);
          if (++i > 20) { clearInterval(iv); res.end(); }
        }, 5);
        res.on("close", () => clearInterval(iv));
      } else if (u.startsWith("/media")) {
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(mediaBuf);
      } else if (u.startsWith("/html")) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html>not media</html>");
      } else {
        res.writeHead(404); res.end();
      }
    });
    server.listen(0, "127.0.0.1", () => {
      serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

let mediaBuf: Buffer;
beforeAll(async () => {
  const fx = await makeFixture("image", dir);
  mediaBuf = await readFile(fx.path);
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await h.close();
});
beforeEach(async () => {
  await prisma.derivative.deleteMany({});
  await prisma.blobReference.deleteMany({});
  await prisma.job.deleteMany({});
  await prisma.asset.deleteMany({});
  await prisma.blobObject.deleteMany({});
});

describe("受限下载器：不能把任意 URL 当服务器读取本地资源的入口", () => {
  it("file:// 协议直接拒绝（防本地文件读取）", async () => {
    expect(() => parseAllowedUrl("file:///etc/passwd")).toThrow(/http/);
  });

  it("非白名单主机拒绝（gopher 内网域名等）", async () => {
    await expect(openRemoteStream("http://evil.example.com/a.png")).rejects.toMatchObject({ code: "HOST_NOT_ALLOWED" });
  });

  it("环回地址默认拒绝（除非显式白名单）", async () => {
    // setup 里为测试把 127.0.0.1 放进了白名单；这里验证私网判断逻辑：
    // 169.254 / 10.x 即便误配成白名单主机，DNS 校验仍拦截
    await expect(openRemoteStream("http://169.254.169.254/latest/meta-data")).rejects.toThrow();
  });

  it("重定向到 file:// 被拒", async () => {
    await expect(openRemoteStream(`${serverUrl}/redirect-file`)).rejects.toMatchObject({ code: "SCHEME_FORBIDDEN" });
  });

  it("非媒体 Content-Type 被拒", async () => {
    await expect(openRemoteStream(`${serverUrl}/html`)).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE" });
  });

  it("流式超大响应在传输中被掐断（恶意超大文件，即便无 Content-Length）", async () => {
    // /huge 不返回 content-length，靠流中计数硬限制
    await expect(
      (async () => {
        const r = await openRemoteStream(`${serverUrl}/huge`);
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of r.stream) { /* drain */ }
      })()
    ).rejects.toBeTruthy();
  });
});

describe("远程导入走真实管线", () => {
  it("白名单主机的媒体导入成功并进入素材库", async () => {
    // 用本地服务器，但把 Host 头/主机名处理为白名单：127.0.0.1 已在测试白名单
    const r = await h.app.inject({
      method: "POST", url: h.base("/remote-import"),
      headers: await authHeaders(h.projectA.token, { "content-type": "application/json" }),
      payload: { url: `${serverUrl}/media`, filename: "remote.png" },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.assetId).toBeTruthy();
    const a = await h.app.inject({ method: "GET", url: h.base(`/assets/${body.assetId}`), headers: await authHeaders(h.projectA.token) });
    expect(a.statusCode).toBe(200);
    expect(a.json().kind).toBe("image");
  });

  it("远程 URL 非法载荷返回结构化错误（非 500）", async () => {
    const r = await h.app.inject({
      method: "POST", url: h.base("/remote-import"),
      headers: await authHeaders(h.projectA.token, { "content-type": "application/json" }),
      payload: { url: "file:///etc/passwd" },
    });
    expect([400, 422]).toContain(r.statusCode);
    expect(r.json().errorCode).toBeTruthy();
  });

  it("导入的素材同样进入转码状态机（视频场景由 worker 完成）", async () => {
    const r = await h.app.inject({
      method: "POST", url: h.base("/remote-import"),
      headers: await authHeaders(h.projectA.token, { "content-type": "application/json" }),
      payload: { url: `${serverUrl}/media` },
    });
    expect(r.statusCode).toBe(201);
    await worker.drain(15_000).catch(() => undefined);
    const list = await h.app.inject({ method: "GET", url: h.base("/assets?status=READY"), headers: await authHeaders(h.projectA.token) });
    expect((list.json().items as unknown[]).length).toBeGreaterThan(0);
  });
});

void RemoteFetchError;
