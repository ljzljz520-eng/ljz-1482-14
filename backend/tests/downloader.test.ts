import { vi } from "vitest";
/**
 * 受限下载器集成测试：用本机临时 HTTP 服务器作为“外部源”，
 * 不访问真实网络（fixture 仅用于隔离测试）。通过把白名单主机名 pin 到回环地址，
 * 验证：正常下载、3xx 逐跳跟随、跳内网被拦、大小上限中断。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// 仅在本模块内把白名单主机名解析到回环（模拟 Docker 内网服务名）。
vi.mock("../src/lib/netGuard.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/netGuard.js")>("../src/lib/netGuard.js");
  return {
    ...actual,
    evaluateUrl: vi.fn(async (rawUrl: string) => {
      const url = new URL(rawUrl);
      const host = url.hostname;
      if (host === "allowed.test") return { url, host, addresses: ["127.0.0.1"] };
      // 第二跳内网字面量必须被拦
      throw new (await import("../src/lib/errors.js")).AppError(
        "REMOTE_URL_BLOCKED",
        "blocked in test",
        422,
        { reason: "private_ip_literal" }
      );
    })
  };
});

import { restrictedDownload } from "../src/lib/downloader.js";

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    const p = req.url ?? "/";
    if (p === "/ok") {
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": "11" });
      res.end(Buffer.from("hello-world"));
    } else if (p === "/redirect") {
      res.writeHead(302, { Location: `http://allowed.test:${port}/ok` });
      res.end();
    } else if (p === "/to-internal") {
      res.writeHead(302, { Location: "http://127.0.0.1/secret" });
      res.end();
    } else if (p === "/declared-large") {
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(500 * 1024 * 1024) });
      res.end();
    } else if (p === "/stream-large") {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      const big = Buffer.alloc(1024 * 1024, 0x58);
      let count = 0;
      const write = () => {
        while (count < 300) {
          if (!res.write(big)) {
            res.once("drain", write);
            return;
          }
          count += 1;
        }
        res.end();
      };
      write();
      res.on("close", () => {
        count = 999;
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("restrictedDownload（隔离 HTTP fixture）", () => {
  it("正常下载小文件并记录大小/类型", async () => {
    const r = await restrictedDownload(`http://allowed.test:${port}/ok`);
    expect(r.sizeBytes).toBe(11);
    expect(r.contentType).toBe("video/mp4");
    expect(r.redirects).toBe(0);
  });

  it("跟随合法重定向并计数", async () => {
    const r = await restrictedDownload(`http://allowed.test:${port}/redirect`);
    expect(r.sizeBytes).toBe(11);
    expect(r.redirects).toBe(1);
  });

  it("重定向到内网地址时拒绝（逐跳安全校验）", async () => {
    await expect(restrictedDownload(`http://allowed.test:${port}/to-internal`)).rejects.toMatchObject({
      code: "REMOTE_URL_BLOCKED"
    });
  });

  it("Content-Length 超限时立即拒绝且不下载 body", async () => {
    await expect(restrictedDownload(`http://allowed.test:${port}/declared-large`)).rejects.toMatchObject({
      code: "REMOTE_RESOURCE_TOO_LARGE",
      httpStatus: 413
    });
  });
});
