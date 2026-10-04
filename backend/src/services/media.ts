import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { config } from "../config.js";
import { TMP_DIR } from "./blobStore.js";

export interface ProbeResult {
  kind: "video" | "audio" | "image";
  durationMs: number | null;
  width: number | null;
  height: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  codecVideo: string | null;
  codecAudio: string | null;
  formatName: string | null;
  mimeType: string | null;
}

export class ProbeError extends Error {
  constructor(
    public code:
      | "PROBE_TIMEOUT"
      | "PROBE_FAILED"
      | "NO_MEDIA_STREAM"
      | "UNSUPPORTED_CONTAINER",
    message: string,
    public raw?: string
  ) {
    super(message);
    this.name = "ProbeError";
  }
}

interface FfprobeJson {
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    duration?: string;
  }>;
  format?: { format_name?: string; duration?: string; mime_type?: string };
}

function runProcess(
  bin: string,
  args: string[],
  opts: { timeoutMs?: number; signal?: AbortSignal; onStderr?: (s: string) => void } = {}
): Promise<{ stdout: Buffer; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    let stderr = "";
    let settled = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          if (!settled) {
            child.kill("SIGKILL");
            const err = new ProbeError("PROBE_TIMEOUT", `${bin} 超过 ${opts.timeoutMs}ms`);
            reject(err);
          }
        }, opts.timeoutMs)
      : null;

    const onAbort = () => child.kill("SIGKILL");
    opts.signal?.addEventListener("abort", onAbort);

    child.stdout.on("data", (c) => stdoutChunks.push(c));
    child.stderr.on("data", (c) => {
      stderr += c.toString();
      opts.onStderr?.(c.toString());
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      timer && clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      timer && clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ stdout: Buffer.concat(stdoutChunks), stderr, code });
    });
  });
}

const IMAGE_FORMATS = new Set([
  "image2",
  "png_pipe",
  "jpeg_pipe",
  "gif",
  "webp_pipe",
  "tiff_pipe",
  "bmp_pipe",
]);

export async function probe(input: string, timeoutMs?: number, signal?: AbortSignal): Promise<ProbeResult> {
  const { stdout, stderr, code } = await runProcess(
    config.FFPROBE_BIN,
    [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      "-analyzeduration",
      "20M",
      "-probesize",
      "20M",
      input,
    ],
    { timeoutMs, signal }
  );

  if (code !== 0) {
    throw new ProbeError(
      "PROBE_FAILED",
      "ffprobe 无法解析该文件（容器损坏或不是合法音视频/图片）",
      stderr.slice(-2000)
    );
  }

  let json: FfprobeJson;
  try {
    json = JSON.parse(stdout.toString("utf8"));
  } catch {
    throw new ProbeError("PROBE_FAILED", "ffprobe 输出无法解析", stderr.slice(-2000));
  }

  const streams = json.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  const formatName = json.format?.format_name ?? null;
  const durationRaw =
    json.format?.duration ?? video?.duration ?? audio?.duration ?? null;
  const durationMs = durationRaw ? Math.round(Number(durationRaw) * 1000) : null;

  const formats = formatName?.split(",") ?? [];
  const isImage = formats.some((f) => IMAGE_FORMATS.has(f));

  // 同一文件既出现多个视频流又有极长时长等异常容器：只认主流，不报错；这里保证不是伪装。
  if (!video && !audio) {
    throw new ProbeError(
      "NO_MEDIA_STREAM",
      "文件中没有可识别的视频、音频或图像流",
      stderr.slice(-2000)
    );
  }

  if (isImage || (video && (!durationMs || durationMs < 50) && !audio)) {
    return {
      kind: "image",
      durationMs: null,
      width: video?.width ?? null,
      height: video?.height ?? null,
      hasVideo: true,
      hasAudio: false,
      codecVideo: video?.codec_name ?? null,
      codecAudio: null,
      formatName,
      mimeType: json.format?.mime_type ?? null,
    };
  }

  if (!video && audio) {
    return {
      kind: "audio",
      durationMs,
      width: null,
      height: null,
      hasVideo: false,
      hasAudio: true,
      codecVideo: null,
      codecAudio: audio.codec_name ?? null,
      formatName,
      mimeType: json.format?.mime_type ?? null,
    };
  }

  return {
    kind: "video",
    durationMs,
    width: video?.width ?? null,
    height: video?.height ?? null,
    hasVideo: true,
    hasAudio: !!audio,
    codecVideo: video?.codec_name ?? null,
    codecAudio: audio?.codec_name ?? null,
    formatName,
    mimeType: json.format?.mime_type ?? null,
  };
}

export interface TranscodeOptions {
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

export interface TranscodeOutput {
  path: string;
  mimeType: string;
  width?: number;
  height?: number;
}

/** 视频预览：H.264/AAC 720p 以内、faststart，浏览器可直接播放的正式预览源 */
export async function transcodeVideoPreview(
  input: string,
  durationMs: number | null,
  opts: TranscodeOptions = {}
): Promise<TranscodeOutput> {
  const out = join(TMP_DIR, `vp-${randomUUID()}.mp4`);
  await runFfmpeg(
    [
      "-y",
      "-i",
      input,
      "-vf",
      "scale='min(1280,iw)':-2",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "26",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      "-progress",
      "pipe:2",
      "-nostats",
      out,
    ],
    durationMs,
    out,
    opts
  );
  return { path: out, mimeType: "video/mp4" };
}

/** 音频预览：128k AAC，兼容浏览器 */
export async function transcodeAudioPreview(
  input: string,
  durationMs: number | null,
  opts: TranscodeOptions = {}
): Promise<TranscodeOutput> {
  const out = join(TMP_DIR, `ap-${randomUUID()}.m4a`);
  await runFfmpeg(
    [
      "-y",
      "-i",
      input,
      "-vn",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      "-progress",
      "pipe:2",
      "-nostats",
      out,
    ],
    durationMs,
    out,
    opts
  );
  return { path: out, mimeType: "audio/mp4" };
}

/** 视频缩略图：取靠前一帧，封面图 */
export async function transcodeThumbnail(
  input: string,
  atMs: number | null,
  opts: TranscodeOptions = {}
): Promise<TranscodeOutput & { width: number; height: number }> {
  const out = join(TMP_DIR, `th-${randomUUID()}.jpg`);
  const seek = atMs ? Math.min(1, Math.max(0, atMs / 1000 / 10)) : 0;
  await runFfmpeg(
    [
      "-y",
      "-ss",
      String(seek),
      "-i",
      input,
      "-frames:v",
      "1",
      "-vf",
      "scale='min(640,iw)':-2",
      "-q:v",
      "4",
      out,
    ],
    null,
    out,
    opts
  );
  const meta = await probe(out, 10_000, opts.signal);
  return { path: out, mimeType: "image/jpeg", width: meta.width ?? 0, height: meta.height ?? 0 };
}

/** 图片缩略图：长边 640 的 JPEG */
export async function transcodeImageThumbnail(
  input: string,
  opts: TranscodeOptions = {}
): Promise<TranscodeOutput & { width: number; height: number }> {
  const out = join(TMP_DIR, `im-${randomUUID()}.jpg`);
  await runFfmpeg(
    ["-y", "-i", input, "-vf", "scale='min(640,iw)':-2", "-q:v", "4", out],
    null,
    out,
    opts
  );
  const meta = await probe(out, 10_000, opts.signal);
  return { path: out, mimeType: "image/jpeg", width: meta.width ?? 0, height: meta.height ?? 0 };
}

/** 音频波形图：失败不致命，仅用于可视化 */
export async function transcodeWaveform(
  input: string,
  opts: TranscodeOptions = {}
): Promise<TranscodeOutput & { width: number; height: number }> {
  const out = join(TMP_DIR, `wf-${randomUUID()}.png`);
  await runFfmpeg(
    [
      "-y",
      "-i",
      input,
      "-filter_complex",
      "showwavespic=s=1024x160:colors=0ea5e9",
      "-frames:v",
      "1",
      out,
    ],
    null,
    out,
    opts
  );
  return { path: out, mimeType: "image/png", width: 1024, height: 160 };
}

async function runFfmpeg(
  args: string[],
  durationMs: number | null,
  outPath: string,
  opts: TranscodeOptions
): Promise<void> {
  let lastPct = 0;
  try {
    const { code, stderr } = await runProcess(config.FFMPEG_BIN, args, {
      signal: opts.signal,
      timeoutMs: 10 * 60 * 1000,
      onStderr: (chunk) => {
        if (!durationMs || !opts.onProgress) return;
        for (const line of chunk.split(/\r?\n/)) {
          const m = line.match(/out_time_ms=(\d+)/) ?? line.match(/out_time_us=(\d+)/);
          if (m) {
            const us = Number(m[1]);
            const ms = line.includes("out_time_us=") ? us / 1000 : us;
            const pct = Math.min(99, Math.max(lastPct, Math.round((ms / durationMs) * 100)));
            lastPct = pct;
            opts.onProgress(pct);
          }
        }
      },
    });
    if (code !== 0) {
      throw new ProbeError("PROBE_FAILED", `ffmpeg 转码失败 (exit=${code})`);
    }
    opts.onProgress?.(100);
  } catch (err) {
    await unlink(outPath).catch(() => undefined);
    if ((err as Error).name === "ProbeError" && (err as ProbeError).code === "PROBE_TIMEOUT") {
      throw new ProbeError("PROBE_FAILED", "ffmpeg 转码超时");
    }
    if ((err as Error).message?.includes("SIGKILL")) {
      throw new Error("转码任务已取消");
    }
    throw err;
  }
}

export async function cleanupFile(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
}

