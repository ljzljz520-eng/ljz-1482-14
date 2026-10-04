import dns from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import net from "node:net";
import { AppError, ErrorCodes } from "./errors.js";

export interface UrlDecision {
  url: URL;
  host: string;
  /** 本次解析出的全部地址（IPv4/IPv6） */
  addresses: string[];
}

/** 判断 IP 是否属于禁止服务器主动访问的区间（回环/私网/链路本地/保留地址）。 */
export function isBlockedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) {
    const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
      return true;
    }
    const [a, b] = parts;
    if (a === 0) return true; // 0.0.0.0/8 "this network"
    if (a === 10) return true; // 私网
    if (a === 127) return true; // 回环
    if (a === 169 && b === 254) return true; // 链路本地
    if (a === 172 && b >= 16 && b <= 31) return true; // 私网
    if (a === 192 && b === 168) return true; // 私网
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a === 192 && b === 0 && parts[2] === 0) return true; // IETF 协议保留 192.0.0/24
    if (a === 198 && (b === 18 || b === 19)) return true; // 基准测试
    if (a >= 224) return true; // 组播/保留 224.0.0.0+
    return false;
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80")) return true; // 链路本地
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // 唯一本地
    if (lower.startsWith("ff")) return true; // 组播
    // IPv4-mapped / IPv4-compatible: ::ffff:a.b.c.d —— 取出嵌入 IPv4 再判定
    const mapped = lower.match(/::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIp(mapped[1]);
    if (lower.startsWith("2001:db8")) return true; // 文档保留
    if (lower.startsWith("64:ff9b")) return false; // NAT64 前缀本身不拦，由目标决定
    return false;
  }
  return true; // 无法识别的地址一律拦截
}

/**
 * 评估一个 URL 是否允许服务器主动访问。
 * 规则：
 *  1. 仅允许 http/https，禁止 file: / gopher: / ftp: 等把任意 URL 变成本地资源入口；
 *  2. 主机白名单（REMOTE_ALLOW_HOSTS）优先——非白名单域名直接拒绝；
 *  3. 禁止直接以 IP 字面量访问内网；
 *  4. DNS 解析后逐个地址检查，任一落入保留区间即拒绝（同时供下载器 pin 住地址防 DNS 重绑定）。
 */
export async function evaluateUrl(rawUrl: string, allowHosts: string[]): Promise<UrlDecision> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError(ErrorCodes.URL_BLOCKED, "远程链接格式不合法", 422, {
      reason: "invalid_url"
    });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError(ErrorCodes.URL_BLOCKED, `协议 ${url.protocol} 不被允许，仅支持 http/https`, 422, {
      reason: "scheme_not_allowed"
    });
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.length === 0) {
    throw new AppError(ErrorCodes.URL_BLOCKED, "链接缺少主机名", 422, { reason: "empty_host" });
  }

  // 凭证内嵌（user:pass@host）拒绝，防止借白名单主机跳转内网
  if (url.username || url.password) {
    throw new AppError(ErrorCodes.URL_BLOCKED, "链接中不允许包含访问凭证", 422, {
      reason: "credentials_in_url"
    });
  }

  // localhost 及其别名一律拒绝：名字解析到回环，等同直接打本机。
  // （内网 fixture 请使用服务名，如 http://fixtures:9000，而非 localhost。）
  const LOCALHOST_NAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"]);
  if (LOCALHOST_NAMES.has(host) || host.endsWith(".localhost")) {
    throw new AppError(ErrorCodes.URL_BLOCKED, "禁止通过 localhost/回环别名访问，请使用服务名", 422, {
      reason: "localhost_name_blocked",
      host
    });
  }

  // 直接以 IP 字面量给出时恒拦私网/保留地址（先于白名单判断，防止 127.0.0.1 被加进白名单绕过）：
  // 白名单信任锚是“主机名”，IP 字面量可指向任意内网主机或云元数据端点。
  if (net.isIP(host)) {
    if (isBlockedIp(host)) {
      throw new AppError(ErrorCodes.URL_BLOCKED, "目标地址指向内网或保留地址，已拒绝", 422, {
        reason: "private_ip_literal",
        host
      });
    }
    // 公网 IP 字面量且未被上面拦截：白名单为空时放行，否则仍要求显式包含该字面量
    if (allowHosts.length > 0 && !allowHosts.includes(host)) {
      throw new AppError(ErrorCodes.URL_BLOCKED, "主机不在允许访问的地址名单内", 422, {
        reason: "host_not_allowlisted",
        host
      });
    }
    return { url, host, addresses: [host] };
  }

  if (allowHosts.length > 0 && !allowHosts.includes(host)) {
    throw new AppError(ErrorCodes.URL_BLOCKED, "主机不在允许访问的地址名单内", 422, {
      reason: "host_not_allowlisted",
      host
    });
  }

  let records: LookupAddress[];
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new AppError(ErrorCodes.URL_BLOCKED, "域名解析失败，无法确认目标地址", 422, {
      reason: "dns_resolution_failed",
      host
    });
  }

  const addresses = records.map((r) => r.address);
  if (addresses.length === 0) {
    throw new AppError(ErrorCodes.URL_BLOCKED, "域名未解析到任何地址", 422, {
      reason: "dns_empty",
      host
    });
  }
  // 主机名已通过白名单校验：内网服务名（如 fixtures）解析到 Docker 内网地址属预期，放行。
  // 未配置白名单（allowHosts 为空）时保持严格模式：解析到私网/保留地址一律拒绝。
  const hostAllowlisted = allowHosts.length > 0 && allowHosts.includes(host);
  if (!hostAllowlisted) {
    for (const address of addresses) {
      if (isBlockedIp(address)) {
        throw new AppError(ErrorCodes.URL_BLOCKED, "域名解析到内网/保留地址，已拒绝", 422, {
          reason: "private_ip_resolved",
          host,
          address
        });
      }
    }
  }
  return { url, host, addresses };
}
