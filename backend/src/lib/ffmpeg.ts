import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { childLogger } from "./logger.js";

const log = childLogger("ffmpeg");

let cachedFfmpeg: string | null | undefined;
let cachedFfprobe: string | null | undefined;

async function loadFfmpegStatic(): Promise<string | null> {
  try {
    const mod = (await import("ffmpeg-static")).default;
    return mod && existsSync(mod) ? mod : null;
  } catch {
    return null;
  }
}

async function loadFfprobeStatic(): Promise<string | null> {
  try {
    const mod = (await import("ffprobe-static")).default;
    if (mod?.path && existsSync(mod.path)) return mod.path;
  } catch {
    /* ignore */
  }
  return null;
}

/** 解析 ffmpeg：环境变量 > 系统 PATH（Docker 内 apt 安装）> ffmpeg-static。 */
export async function resolveFfmpeg(): Promise<string> {
  if (cachedFfmpeg !== undefined) return cachedFfmpeg as string;
  const fromEnv = process.env.FFMPEG_PATH;
  if (fromEnv && existsSync(fromEnv)) {
    cachedFfmpeg = fromEnv;
    return fromEnv;
  }
  const system = spawnSync("ffmpeg", ["-version"], { encoding: "buffer" });
  // 注意：二进制不存在时 status 为 null 且 error.code=ENOENT，必须同时检查 error
  if (system.status === 0 && !system.error) {
    cachedFfmpeg = "ffmpeg";
    return "ffmpeg";
  }
  const staticPath = await loadFfmpegStatic();
  if (staticPath) {
    cachedFfmpeg = staticPath;
    return staticPath;
  }
  throw new Error("未找到可用的 ffmpeg 二进制（系统 PATH 与 ffmpeg-static 均不可用）");
}

/** ffprobe 为可选项：缺失时媒体服务自动回退到 `ffmpeg -i` 输出解析。 */
export async function resolveFfprobe(): Promise<string | null> {
  if (cachedFfprobe !== undefined) return cachedFfprobe;
  const fromEnv = process.env.FFPROBE_PATH;
  if (fromEnv && existsSync(fromEnv)) {
    cachedFfprobe = fromEnv;
    return fromEnv;
  }
  const system = spawnSync("ffprobe", ["-version"], { encoding: "buffer" });
  if (system.status === 0 && !system.error) {
    cachedFfprobe = "ffprobe";
    return "ffprobe";
  }
  cachedFfprobe = await loadFfprobeStatic();
  return cachedFfprobe;
}

export interface FfmpegRunOptions {
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * 运行 ffmpeg，以 -progress pipe:1 解析转码进度（0..100）。
 * stderr 保留尾部日志用于失败原因定位；支持 AbortSignal 与超时熔断。
 */
export function runFfmpeg(args: string[], options: FfmpegRunOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    void resolveFfmpeg().then((bin) => {
      const progressArgs = options.onProgress ? ["-progress", "pipe:1", "-nostats"] : ["-nostats"];
      const finalArgs = [...progressArgs, ...args, "-y"];
      const child = spawn(bin, finalArgs, { stdio: ["ignore", "pipe", "pipe"] });

      let stderrTail = "";
      let totalDurationUs = -1;
      let timedOut = false;

      const timer = options.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeoutMs)
        : null;

      child.stderr.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString("utf8")).slice(-12000);
        if (totalDurationUs < 0) {
          const m = /Duration:\s(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderrTail);
          if (m) {
            const [, h, mi, s] = m;
            totalDurationUs = Math.round(
              (Number(h) * 3600 + Number(mi) * 60 + Number(s)) * 1_000_000
            );
          }
        }
      });

      if (options.onProgress) {
        let buf = "";
        child.stdout.on("data", (chunk: Buffer) => {
          buf += chunk.toString("utf8");
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line.startsWith("out_time_us=") && totalDurationUs > 0) {
              const cur = Number(line.split("=")[1]);
              if (Number.isFinite(cur) && cur >= 0) {
                options.onProgress!(Math.min(99, Math.round((cur / totalDurationUs) * 100)));
              }
            } else if (line === "progress=end") {
              options.onProgress!(100);
            }
          }
        });
      } else {
        child.stdout.resume();
      }

      options.signal?.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });

      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        if (timedOut) {
          reject(new Error(`ffmpeg 执行超时（>${options.timeoutMs}ms）`));
          return;
        }
        if (code === 0) {
          resolve();
        } else {
          log.warn({ code, args: args.join(" ") }, "ffmpeg failed");
          reject(new Error(`ffmpeg 退出码 ${code}；日志尾部：${stderrTail.slice(-1500)}`));
        }
      });
    }, reject);
  });
}

/** 收集型执行：用于探测（ffprobe 或 ffmpeg -i，后者把信息写到 stderr）。 */
export async function runCollect(
  bin: string,
  args: string[],
  timeoutMs = 60_000
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
