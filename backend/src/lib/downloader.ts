import type { LookupFunction } from "node:net";
import { Transform } from "node:stream";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { Agent, request } from "undici";
import { pipeline } from "node:stream/promises";
import { env } from "../config/env.js";
import { AppError, ErrorCodes } from "./errors.js";
import { childLogger } from "./logger.js";
import { evaluateUrl } from "./netGuard.js";
import { tmpPath } from "./storage.js";

const log = childLogger("downloader");

export interface DownloadResult {
  tmpPath: string;
  sizeBytes: number;
  contentType: string;
  httpStatus: number;
  redirects: number;
  resolvedIp: string;
  finalUrl: string;
}

/** 流式计数：一旦超过上限立即销毁流，使 pipeline 失败中断。 */
class SizeGuardStream extends Transform {
  received = 0;
  constructor(private readonly limit: number) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null, out?: Buffer) => void) {
    this.received += chunk.length;
    if (this.received > this.limit) {
      this.destroy(new Error("remote size limit exceeded"));
      return;
    }
    cb(null, chunk);
  }
}

/**
 * 构造“地址钉住”的 Agent：connect.lookup 只允许连接到本跳 evaluateUrl 已校验的地址，
 * 防止 DNS 重绑定（校验时一个地址，连接时换成内网地址）。
 */
function makePinnedAgent(addressMap: Map<string, string[]>, timeoutMs: number): Agent {
  const pinnedLookup: LookupFunction = (hostname, options, callback) => {
    const host = String(hostname).toLowerCase().replace(/\.$/, "");
    const addresses = addressMap.get(host);
    if (!addresses || addresses.length === 0) {
      if (options.all) {
        callback(new Error(`连接到未经安全校验的主机被拒绝: ${host}`), []);
      } else {
        callback(new Error(`连接到未经安全校验的主机被拒绝: ${host}`), "", 0);
      }
      return;
    }
    if (options.all) {
      callback(
        null,
        addresses.map((address) => ({ address, family: (address.includes(":") ? 6 : 4) as 0 | 4 | 6 }))
      );
      return;
    }
    const address = addresses[0];
    callback(null, address, address.includes(":") ? 6 : 4);
  };

  return new Agent({
    connect: {
      timeout: Math.min(timeoutMs, 10_000),
      lookup: pinnedLookup
    }
  });
}

function abortBody(response: { body: { on: Function; destroy: Function } }): void {
  try {
    response.body.on("error", () => undefined); // 销毁会 emit AbortError，吞掉避免 unhandled
    response.body.destroy();
  } catch {
    /* ignore */
  }
}

/**
 * 受限下载器：远程链接绝不能成为读取本地/内网资源的入口。
 * - 协议仅 http(s)，主机白名单 + 私网/保留地址拦截；
 * - 逐跳重定向评估，每一跳都重新做主机与地址检查；
 * - DNS 解析结果 pin 到连接器，防止 DNS 重绑定；
 * - Content-Length 预检 + 流式计数双重大小控制；
 * - 方法仅 GET，不携带任何凭证头，超时熔断。
 */
export async function restrictedDownload(rawUrl: string): Promise<DownloadResult> {
  let currentUrl = rawUrl;
  let redirects = 0;
  let resolvedIp = "";
  // 各跳主机 -> 已校验地址（每跳只加入当跳评估出的主机）
  const addressMap = new Map<string, string[]>();

  for (;;) {
    const decision = await evaluateUrl(currentUrl, env.remoteAllowHosts);
    addressMap.set(decision.host, decision.addresses);
    if (!resolvedIp) resolvedIp = decision.addresses[0];

    const agent = makePinnedAgent(addressMap, env.remoteFetchTimeoutMs);

    let response;
    try {
      response = await request(decision.url, {
        method: "GET",
        // undici.request 默认不自动跟随重定向：3xx 作为普通响应返回，由我们逐跳安全校验
        headersTimeout: env.remoteFetchTimeoutMs,
        bodyTimeout: env.remoteFetchTimeoutMs,
        dispatcher: agent
      });
    } catch (err) {
      await agent.close().catch(() => undefined);
      log.warn({ url: currentUrl, err: (err as Error).message }, "remote fetch transport error");
      throw new AppError(
        ErrorCodes.REMOTE_FETCH_FAILED,
        "远程链接连接失败或已被安全策略中断",
        502,
        { reasonCode: "transport_error" }
      );
    }

    const status = response.statusCode;

    if (status >= 300 && status < 400) {
      abortBody(response);
      await agent.close().catch(() => undefined);
      const location = response.headers.location;
      if (!location) {
        throw new AppError(ErrorCodes.REMOTE_FETCH_FAILED, "重定向响应缺少 Location", 502, {
          reasonCode: "redirect_without_location"
        });
      }
      redirects += 1;
      if (redirects > env.maxRedirects) {
        throw new AppError(
          ErrorCodes.REMOTE_FETCH_FAILED,
          `重定向次数超过上限 ${env.maxRedirects}`,
          502,
          { reasonCode: "too_many_redirects" }
        );
      }
      // 相对地址基于当前 URL 解析，下一跳重新过完整安全检查
      currentUrl = new URL(String(location), decision.url).toString();
      continue;
    }

    if (status < 200 || status >= 300) {
      abortBody(response);
      await agent.close().catch(() => undefined);
      throw new AppError(
        ErrorCodes.REMOTE_FETCH_FAILED,
        `远程服务器返回状态码 ${status}`,
        502,
        { reasonCode: "bad_http_status", httpStatus: status }
      );
    }

    const contentType = String(response.headers["content-type"] ?? "application/octet-stream")
      .split(";")[0]
      .trim();
    const declaredLength = Number(response.headers["content-length"] ?? NaN);
    if (Number.isFinite(declaredLength) && declaredLength > env.maxRemoteBytes) {
      abortBody(response); // 立即中断，绝不读完超大响应体
      await agent.close().catch(() => undefined);
      throw new AppError(
        ErrorCodes.REMOTE_TOO_LARGE,
        `资源声明大小 ${declaredLength} 字节，超过上限 ${env.maxRemoteBytes} 字节`,
        413,
        {
          reasonCode: "content_length_exceeded",
          httpStatus: status,
          redirects,
          resolvedIp,
          contentType
        }
      );
    }

    const dest = tmpPath("remote-fetch");
    const guard = new SizeGuardStream(env.maxRemoteBytes);
    let exceeded = false;
    try {
      await pipeline(response.body, guard, createWriteStream(dest));
    } catch (err) {
      await agent.close().catch(() => undefined);
      await rm(dest, { force: true });
      if ((err as Error).message.includes("size limit")) {
        exceeded = true;
      } else {
        throw new AppError(ErrorCodes.REMOTE_FETCH_FAILED, "下载过程中连接中断", 502, {
          reasonCode: "stream_aborted"
        });
      }
    }
    await agent.close().catch(() => undefined);

    if (exceeded) {
      throw new AppError(
        ErrorCodes.REMOTE_TOO_LARGE,
        `资源实际大小超过上限 ${env.maxRemoteBytes} 字节，已中断下载`,
        413,
        {
          reasonCode: "stream_size_exceeded",
          httpStatus: status,
          redirects,
          resolvedIp,
          contentType
        }
      );
    }

    return {
      tmpPath: dest,
      sizeBytes: guard.received,
      contentType,
      httpStatus: status,
      redirects,
      resolvedIp,
      finalUrl: decision.url.toString()
    };
  }
}
