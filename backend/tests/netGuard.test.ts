import { describe, it, expect, vi, beforeEach } from "vitest";

// 隔离测试：把 DNS 解析固定为可控结果（真实核心逻辑仍执行，仅隔离外部 DNS）。
vi.mock("node:dns/promises", () => ({
  default: {
    lookup: vi.fn()
  }
}));

import dns from "node:dns/promises";
import { isBlockedIp, evaluateUrl } from "../src/lib/netGuard.js";
import { AppError } from "../src/lib/errors.js";

const dnsMock = dns as unknown as { lookup: ReturnType<typeof vi.fn> };

describe("isBlockedIp", () => {
  it.each([
    ["127.0.0.1"], ["127.1.2.3"], ["10.0.0.1"], ["192.168.1.1"],
    ["172.16.0.1"], ["172.31.255.255"], ["169.254.169.254"],
    ["0.0.0.0"], ["224.0.0.1"], ["100.64.0.1"], ["198.18.0.1"], ["::1"], ["fe80::1"], ["fc00::1"], ["ff02::1"]
  ])("拦截保留/内网地址 %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });
  it.each([["8.8.8.8"], ["1.1.1.1"], ["172.32.0.1"], ["172.15.255.255"], ["192.169.0.1"], ["2606:4700:4700::1111"]])(
    "放行公网地址 %s",
    (ip) => expect(isBlockedIp(ip)).toBe(false)
  );
});

describe("evaluateUrl", () => {
  beforeEach(() => dnsMock.lookup.mockReset());

  it("拒绝非 http(s) 协议（file:// 不得成为本地资源入口）", async () => {
    await expect(evaluateUrl("file:///etc/passwd", ["localhost"])).rejects.toMatchObject({
      code: "REMOTE_URL_BLOCKED",
      details: { reason: "scheme_not_allowed" }
    });
    await expect(evaluateUrl("gopher://127.0.0.1/", [])).rejects.toBeInstanceOf(AppError);
  });

  it("拒绝内嵌凭证的 URL", async () => {
    await expect(evaluateUrl("http://user:pass@fixtures/x", ["fixtures"])).rejects.toMatchObject({
      details: { reason: "credentials_in_url" }
    });
  });

  it("非白名单主机直接拒绝", async () => {
    await expect(evaluateUrl("http://evil.example.com/a.mp4", ["fixtures"])).rejects.toMatchObject({
      details: { reason: "host_not_allowlisted" }
    });
  });

  it("IP 字面量指向私网恒拦，即使白名单包含该字面量", async () => {
    await expect(evaluateUrl("http://127.0.0.1:9000/secret", ["127.0.0.1"])).rejects.toMatchObject({
      details: { reason: "private_ip_literal" }
    });
    await expect(evaluateUrl("http://169.254.169.254/latest/", ["169.254.169.254"])).rejects.toMatchObject({
      details: { reason: "private_ip_literal" }
    });
  });

  it("localhost 别名恒拦", async () => {
    await expect(evaluateUrl("http://localhost:9000/x", ["localhost"])).rejects.toMatchObject({
      details: { reason: "localhost_name_blocked" }
    });
  });

  it("白名单域名解析到内网地址（如 Docker 服务名）时放行，地址被 pin", async () => {
    dnsMock.lookup.mockResolvedValue([{ address: "172.18.0.3", family: 4 }]);
    const decision = await evaluateUrl("http://fixtures:9000/sample.mp4", ["fixtures"]);
    expect(decision.addresses).toEqual(["172.18.0.3"]);
    expect(decision.host).toBe("fixtures");
  });

  it("无白名单的严格模式下，域名解析到内网地址仍拒绝（DNS 重绑定/内网域名）", async () => {
    dnsMock.lookup.mockResolvedValue([{ address: "10.1.2.3", family: 4 }]);
    await expect(evaluateUrl("http://internal.corp/x", [])).rejects.toMatchObject({
      details: { reason: "private_ip_resolved" }
    });
  });

  it("公网 IP 字面量 + 白名单包含时放行", async () => {
    const decision = await evaluateUrl("http://8.8.8.8/", ["8.8.8.8"]);
    expect(decision.addresses).toEqual(["8.8.8.8"]);
  });
});
