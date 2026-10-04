import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { config, allowedRemoteHosts } from "../config.js";
import { PayloadTooLargeError } from "./blobStore.js";

export type RemoteFetchErrorCode =
  | "URL_INVALID"
  | "SCHEME_FORBIDDEN"
  | "HOST_NOT_ALLOWED"
  | "PRIVATE_ADDRESS_FORBIDDEN"
  | "TOO_MANY_REDIRECTS"
  | "REMOTE_TOO_LARGE"
  | "REMOTE_TIMEOUT"
  | "REMOTE_UNREACHABLE"
  | "UNSUPPORTED_MEDIA_TYPE";

export class RemoteFetchError extends Error {
  constructor(
    public code: RemoteFetchErrorCode,
    message: string,
    public meta?: Record<string, unknown>
  ) {
    super(message);
    this.name = "RemoteFetchError";
  }
}

export interface FetchStreamResult {
  stream: Readable;
  size: number | null;
  contentType: string | null;
  finalUrl: string;
}

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT
];
function isPrivateV4(ip: string): boolean {
  if (PRIVATE_V4.some((r) => r.test(ip))) return true;
  const parts = ip.split(".").map(Number);
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
  return false;
}

function isPrivateV6(ip: string): boolean {
  const addr = ip.toLowerCase();
  return (
    addr === "::1" ||
    addr.startsWith("fc") ||
    addr.startsWith("fd") ||
    addr.startsWith("fe80") ||
    addr.startsWith("::ffff:127.") ||
    addr.startsWith("::ffff:10.") ||
    /^::ffff:(?:172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/.test(addr)
  );
}

/**
 * 受限下载器：
 * 1) 只允许 http/https；2) 主机必须命中白名单；3) DNS 解析后必须是公网 IP；
 * 4) 重定向只允许再走一次白名单与公网 IP 校验；5) 限制大小并边下边拦；
 * 绝不把任意 URL（file://、内网地址、127.0.0.1）当作读取本地/内网资源的入口。
 */
export async function assertHostAllowed(hostname: string): Promise<void> {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (isIP(host)) {
    const ipVersion = isIP(host);
    const priv = ipVersion === 4 ? isPrivateV4(host) : isPrivateV6(host);
    // 显式白名单：唯一允许私网/环回地址的通道（测试环境使用，生产默认不含内网地址）。
    // 默认策略：白名单只放公网图床域名，内网/环回一律拒绝，杜绝 SSRF 与本地文件/元数据读取。
    if (priv && !allowedRemoteHosts.has(host)) {
      throw new RemoteFetchError("PRIVATE_ADDRESS_FORBIDDEN", `禁止访问内网/环回地址 ${host}`);
    }
    if (!priv && !allowedRemoteHosts.has(host)) {
      throw new RemoteFetchError("HOST_NOT_ALLOWED", `目标地址 ${host} 不在允许列表中`);
    }
    if (priv && allowedRemoteHosts.has(host)) {
      // 私网白名单仅在显式配置时生效（ALLOW_PRIVATE_HOSTS 必须显式打开），双开关避免误配
      if (!process.env.ALLOW_PRIVATE_HOSTS) {
        throw new RemoteFetchError("PRIVATE_ADDRESS_FORBIDDEN", `生产策略禁止访问内网/环回地址 ${host}`);
      }
    }
    return;
  }
  if (!allowedRemoteHosts.has(host)) {
    throw new RemoteFetchError("HOST_NOT_ALLOWED", `远程主机 ${host} 不在允许列表中`);
  }
  const records = await lookup(host, { all: true }).catch((): Array<{ address: string; family: number }> => []);
  if (records.length === 0) {
    throw new RemoteFetchError("REMOTE_UNREACHABLE", `无法解析主机 ${host}`);
  }
  for (const r of records) {
    const priv = r.family === 4 ? isPrivateV4(r.address) : isPrivateV6(r.address);
    if (priv && !process.env.ALLOW_PRIVATE_HOSTS) {
      throw new RemoteFetchError("PRIVATE_ADDRESS_FORBIDDEN", `主机 ${host} 解析到内网地址 ${r.address}`);
    }
  }
}

const ALLOWED_CONTENT_PREFIXES = ["video/", "audio/", "image/", "application/mp4", "application/octet-stream"];

interface RequestOptions {
  method?: "GET" | "HEAD";
  redirectsLeft?: number;
}

interface ResolvedTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

/**
 * 先自行解析 DNS 并校验公网 IP，然后直连该 IP。
 * 这样比在 http agent 的 lookup 回调里做手脚更稳：
 * - 避免 DNS rebinding（解析与连接是同一个 IP）；
 * - Host 头与 TLS SNI 仍用原主机名，证书与服务正常；
 * - 内网/环回地址在连接前即被拒绝。
 */
async function resolvePublicTarget(target: URL): Promise<ResolvedTarget> {
  const host = target.hostname.toLowerCase().replace(/\.$/, "");
  const ipVersion = isIP(host);
  if (ipVersion) {
    const priv = ipVersion === 4 ? isPrivateV4(host) : isPrivateV6(host);
    if (priv && !process.env.ALLOW_PRIVATE_HOSTS) {
      throw new RemoteFetchError("PRIVATE_ADDRESS_FORBIDDEN", `禁止访问内网/环回地址 ${host}`);
    }
    return { url: target, address: host, family: ipVersion === 4 ? 4 : 6 };
  }
  await assertHostAllowed(host);
  const records = await lookup(host, { all: true }).catch(
    (): Array<{ address: string; family: number }> => []
  );
  if (records.length === 0) {
    throw new RemoteFetchError("REMOTE_UNREACHABLE", `无法解析主机 ${host}`);
  }
  const allowPriv = !!process.env.ALLOW_PRIVATE_HOSTS;
  const pick = records.find((r) => allowPriv || !(r.family === 4 ? isPrivateV4(r.address) : isPrivateV6(r.address)));
  if (!pick) {
    throw new RemoteFetchError("PRIVATE_ADDRESS_FORBIDDEN", `主机 ${host} 解析到内网地址`);
  }
  const url = new URL(target.toString());
  if (pick.family === 6) {
    url.hostname = `[${pick.address}]`;
  } else {
    url.hostname = pick.address;
  }
  // 直连 IP，但保留主机名用于 Host 头 / SNI
  return { url, address: pick.address, family: pick.family === 6 ? 6 : 4 };
}

function requestTo(
  originalHost: string,
  target: URL,
  opts: RequestOptions
): Promise<{
  statusCode?: number;
  headers: http.IncomingHttpHeaders;
  stream?: Readable;
  request: http.ClientRequest;
}> {
  return new Promise((resolve, reject) => {
    const lib = target.protocol === "https:" ? https : http;
    const req = lib.request(
      target,
      {
        method: opts.method ?? "GET",
        headers: {
          Host: originalHost,
          "User-Agent": "AudioVisualAssetService/1.0",
          Accept: "video/*, audio/*, image/*, application/octet-stream",
        },
        servername: target.protocol === "https:" ? originalHost : undefined,
        timeout: config.REMOTE_TIMEOUT_MS,
      },
      (res) => resolve({ statusCode: res.statusCode, headers: res.headers, stream: res, request: req })
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new RemoteFetchError("REMOTE_TIMEOUT", `请求 ${originalHost} 超时`));
    });
    req.on("error", (err) => {
      reject(new RemoteFetchError("REMOTE_UNREACHABLE", `无法连接 ${originalHost}: ${err.message}`));
    });
    req.end();
  });
}

export async function preflight(urlString: string): Promise<{
  size: number | null;
  contentType: string | null;
  finalUrl: string;
}> {
  const url = parseAllowedUrl(urlString);
  const resolved = await resolvePublicTarget(url);
  const res = await requestTo(url.hostname, resolved.url, { method: "HEAD", redirectsLeft: 2 });
  const status = res.statusCode ?? 0;
  if (status >= 300 && status < 400 && res.headers.location) {
    res.request.destroy();
    const next = new URL(res.headers.location, url);
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      throw new RemoteFetchError("SCHEME_FORBIDDEN", `重定向协议 ${next.protocol} 被禁止`);
    }
    const nextResolved = await resolvePublicTarget(next);
    return preflight(next.toString());
  }
  res.request.destroy();
  if (status !== 200) {
    throw new RemoteFetchError("REMOTE_UNREACHABLE", `预检失败 HTTP ${status}`);
  }
  const size = res.headers["content-length"] ? Number(res.headers["content-length"]) : null;
  if (size !== null && size > config.MAX_REMOTE_BYTES) {
    throw new RemoteFetchError(
      "REMOTE_TOO_LARGE",
      `远程对象 ${size} 字节超过上限 ${config.MAX_REMOTE_BYTES} 字节`,
      { size, limit: config.MAX_REMOTE_BYTES }
    );
  }
  return { size, contentType: res.headers["content-type"] ?? null, finalUrl: url.toString() };
}

export function parseAllowedUrl(urlString: string): URL {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new RemoteFetchError("URL_INVALID", "URL 格式不合法");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RemoteFetchError(
      "SCHEME_FORBIDDEN",
      `协议 ${url.protocol} 被禁止：远程拉取只允许 http/https`
    );
  }
  // 显式挡掉凭据形式 http://user:pass@host
  if (url.username || url.password) {
    throw new RemoteFetchError("URL_INVALID", "URL 中不允许携带用户凭据");
  }
  return url;
}

/** 打开受限下载流：可中断、限大小、跟随最多 2 次重定向（每次都过白名单） */
export async function openRemoteStream(
  urlString: string,
  redirectsLeft = 2
): Promise<FetchStreamResult> {
  const originalUrl = parseAllowedUrl(urlString);
  const resolved = await resolvePublicTarget(originalUrl);
  const res = await requestTo(originalUrl.hostname, resolved.url, { redirectsLeft });
  const status = res.statusCode ?? 0;

  if (status >= 300 && status < 400 && res.headers.location) {
    res.request.destroy();
    if (redirectsLeft <= 0) {
      throw new RemoteFetchError("TOO_MANY_REDIRECTS", "重定向次数超过上限");
    }
    const next = new URL(res.headers.location, originalUrl);
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      throw new RemoteFetchError("SCHEME_FORBIDDEN", `重定向协议 ${next.protocol} 被禁止`);
    }
    await assertHostAllowed(next.hostname);
    return openRemoteStream(next.toString(), redirectsLeft - 1);
  }
  if (status !== 200) {
    res.request.destroy();
    throw new RemoteFetchError("REMOTE_UNREACHABLE", `下载失败 HTTP ${status}`);
  }

  const contentType = (res.headers["content-type"] ?? "").split(";")[0].trim() || null;
  if (contentType && !ALLOWED_CONTENT_PREFIXES.some((p) => contentType.startsWith(p))) {
    res.request.destroy();
    throw new RemoteFetchError(
      "UNSUPPORTED_MEDIA_TYPE",
      `内容类型 ${contentType} 不是允许的音视频/图片类型`
    );
  }
  const declared = res.headers["content-length"] ? Number(res.headers["content-length"]) : null;
  if (declared !== null && declared > config.MAX_REMOTE_BYTES) {
    res.request.destroy();
    throw new RemoteFetchError(
      "REMOTE_TOO_LARGE",
      `远程对象 ${declared} 字节超过上限 ${config.MAX_REMOTE_BYTES} 字节`
    );
  }

  // 流式硬限制：即使服务端不给 Content-Length，也边下边拦恶意超大文件
  let received = 0;
  const guarded = new Readable({
    read() {},
  });
  res.stream!.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (received > config.MAX_REMOTE_BYTES) {
      res.request.destroy();
      guarded.destroy(
        new PayloadTooLargeError(config.MAX_REMOTE_BYTES, received)
      );
      return;
    }
    if (!guarded.push(chunk)) res.stream!.pause();
  });
  res.stream!.on("end", () => guarded.push(null));
  res.stream!.on("error", (err) => guarded.destroy(err));
  guarded._read = () => res.stream!.resume();

  return {
    stream: guarded,
    size: declared,
    contentType,
    finalUrl: originalUrl.toString(),
  };
}
