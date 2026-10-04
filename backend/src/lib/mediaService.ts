import { resolveFfmpeg, runCollect, runFfmpeg, resolveFfprobe } from "./ffmpeg.js";
import { childLogger } from "./logger.js";

const log = childLogger("media");

export type MediaKind = "video" | "audio" | "image";

export interface MediaProbe {
  mediaType: MediaKind;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
  hasVideo: boolean;
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
}

interface FfprobeJson {
  format?: { duration?: string; format_name?: string };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    duration?: string;
  }>;
}

/**
 * 探测媒体文件。ffprobe 可用时走 JSON；不可用时解析 `ffmpeg -i` stderr。
 * 输出的 hasAudio 是“音轨缺失”验收场景的关键信号。
 */
export async function probeMedia(filePath: string): Promise<MediaProbe> {
  const ffprobe = await resolveFfprobe();
  if (ffprobe) {
    try {
      const { stdout } = await runCollect(ffprobe, [
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        filePath
      ]);
      return parseFfprobeJson(JSON.parse(stdout) as FfprobeJson);
    } catch (err) {
      log.warn({ err: (err as Error).message }, "ffprobe JSON failed, fallback to ffmpeg -i");
    }
    void 0;
  }
  const ffmpeg = await resolveFfmpeg();
  const result = await runCollect(ffmpeg, ["-hide_banner", "-i", filePath]);
  // ffmpeg -i 对无法打开的输入返回非 0；提取关键错误行而不是抛出整段 banner
  if (result.code !== 0 && /(Invalid data|not found|Error opening|moov|does not contain)/i.test(result.stderr)) {
    throw new Error(extractFfmpegError(result.stderr));
  }
  return parseFfmpegBanner(result.stderr);
}

function parseFfprobeJson(json: FfprobeJson): MediaProbe {
  const streams = json.streams ?? [];
  const videoStream = streams.find((s) => s.codec_type === "video");
  const audioStream = streams.find((s) => s.codec_type === "audio");
  const hasVideo = Boolean(videoStream);
  const hasAudio = Boolean(audioStream);
  // ffprobe 中封面图（mjpeg/png）也标记为 video，用容器格式区分
  const formatName = json.format?.format_name ?? "";
  const durationRaw =
    json.format?.duration ?? videoStream?.duration ?? audioStream?.duration ?? null;
  const durationMs = durationRaw ? Math.round(Number(durationRaw) * 1000) : null;

  const mediaType: MediaKind = imageContainers.includes(formatName)
    ? "image"
    : hasVideo
      ? "video"
      : "audio";

  return {
    mediaType,
    durationMs: mediaType === "image" ? null : durationMs,
    width: videoStream?.width ?? null,
    height: videoStream?.height ?? null,
    hasAudio,
    hasVideo,
    container: formatName || null,
    videoCodec: videoStream?.codec_name ?? null,
    audioCodec: audioStream?.codec_name ?? null
  };
}

const imageContainers = ["png_pipe", "image2", "mjpeg", "png", "jpeg", "gif", "webp_pipe", "bmp_pipe"];

/** 无 ffprobe 时从 ffmpeg banner 文本提取流信息（静态 ffmpeg 常见）。 */
export function parseFfmpegBanner(stderr: string): MediaProbe {
  const streamLines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^Stream #/.test(line));

  let hasVideo = false;
  let hasAudio = false;
  let width: number | null = null;
  let height: number | null = null;
  let videoCodec: string | null = null;
  let audioCodec: string | null = null;

  for (const line of streamLines) {
    const typeMatch = /Stream #\S+.*?: (Video|Audio|Subtitle|Data|Attachment):\s*([^,]+)?/.exec(line);
    if (!typeMatch) continue;
    const type = typeMatch[1];
    if (type === "Video") {
      hasVideo = true;
      videoCodec = (typeMatch[2] ?? "").trim() || null;
      const resMatch = /(\d{2,5})x(\d{2,5})/.exec(line);
      if (resMatch) {
        width = Number(resMatch[1]);
        height = Number(resMatch[2]);
      }
    } else if (type === "Audio") {
      hasAudio = true;
      audioCodec = (typeMatch[2] ?? "").trim() || null;
    }
  }

  let durationMs: number | null = null;
  const durationMatch = /Duration:\s(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (durationMatch) {
    const [, h, m, s] = durationMatch;
    durationMs = Math.round(
      (Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000
    );
  }

  const inputMatch = /from '([^']+)'/.exec(stderr);
  const lowerName = (inputMatch?.[1] ?? "").toLowerCase();
  const looksImage = /\.(png|jpe?g|gif|webp|bmp|avif)$/.test(lowerName);
  const bannerImageOnly =
    looksImage &&
    hasVideo &&
    !hasAudio &&
    (durationMs === null || durationMs === 0 || /(mjpeg|png|bmp)/i.test(videoCodec ?? ""));

  const mediaType: MediaKind = bannerImageOnly ? "image" : hasVideo ? "video" : hasAudio ? "audio" : "image";

  if (mediaType === "image") {
    return {
      mediaType,
      durationMs: null,
      width,
      height,
      hasAudio: false,
      hasVideo: true,
      container: null,
      videoCodec,
      audioCodec: null
    };
  }

  return {
    mediaType,
    durationMs,
    width,
    height,
    hasAudio,
    hasVideo,
    container: null,
    videoCodec,
    audioCodec
  };
}

export interface DeriveResult {
  outputPath: string;
  mimeType: string;
}

export const MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  jpg: "image/jpeg",
  png: "image/png"
};

/**
 * 派生“可预览”版本：
 * - video: 480p H.264/AAC + faststart（浏览器可直接播放的预览）；
 * - audio: 128k AAC m4a 预览；
 * - image: 1280px 长边 jpg 缩略。
 * 原件本身在完整性探测完成后才允许作为正式播放源。
 */
export async function derivePreview(input: string, output: string, mediaType: MediaKind,
  onProgress?: (p: number) => void, signal?: AbortSignal): Promise<DeriveResult> {
  if (mediaType === "video") {
    await runFfmpeg([
      "-i", input,
      "-map", "0:v:0",
      // 有音轨才映射，避免无音轨文件映射失败
      "-map", "0:a?",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "26",
      "-vf", "scale='min(854,iw)':-2",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      output
    ], { onProgress, signal, timeoutMs: 30 * 60_000 });
    return { outputPath: output, mimeType: MIME.mp4 };
  }
  if (mediaType === "audio") {
    await runFfmpeg([
      "-i", input,
      "-vn",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      output
    ], { onProgress, signal, timeoutMs: 30 * 60_000 });
    return { outputPath: output, mimeType: MIME.m4a };
  }
  await runFfmpeg([
    "-i", input,
    "-vf", "scale='min(1280,iw)':-2",
    "-frames:v", "1",
    output
  ], { onProgress, signal, timeoutMs: 60_000 });
  return { outputPath: output, mimeType: MIME.jpg };
}

/** 封面海报：视频抽首帧（取第 1 秒，黑帧概率低）。 */
export async function deriveCover(input: string, output: string, durationMs: number | null): Promise<DeriveResult> {
  const seekSeconds = durationMs && durationMs > 2000 ? "1" : "0";
  await runFfmpeg([
    "-ss", seekSeconds,
    "-i", input,
    "-vf", "scale='min(640,iw)':-2",
    "-frames:v", "1",
    output
  ], { timeoutMs: 60_000 });
  return { outputPath: output, mimeType: MIME.jpg };
}


/** 从冗长 ffmpeg banner 中提取真正的错误行（如 "moov atom not found"）。 */
export function extractFfmpegError(raw: string): string {
  const text = String(raw ?? "");
  if (!/ffmpeg|moov|avcodec|avformat/i.test(text)) return text.slice(0, 300);
  const keyLine = text
    .split("\n")
    .map((line) => line.trim())
    .find(
      (line) =>
        /(Error opening|Invalid data|not found|does not contain|Permission denied|No such file|Invalid argument|moov atom)/i.test(line) &&
        !/Copyright|configuration|built with|version|libav(codec|format|util|device|filter)|^\s*$/.test(line)
    );
  if (keyLine) return keyLine.replace(/^\[.*?\]\s*/, "").slice(0, 300);
  return "媒体处理失败（ffmpeg 未能解析该文件）";
}
