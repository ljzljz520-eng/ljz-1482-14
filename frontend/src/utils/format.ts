export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value >= 100 ? Math.round(value) : value.toFixed(value >= 10 ? 1 : 2)} ${units[i]}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (!ms && ms !== 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export type AssetStatusKey = "received" | "previewable" | "ready" | "failed";

export const STATUS_META: Record<
  AssetStatusKey,
  { label: string; tone: "slate" | "blue" | "amber" | "green" | "red"; desc: string }
> = {
  received: { label: "原件已收", tone: "blue", desc: "源对象已完整落库，正在完整性探测" },
  previewable: { label: "可预览", tone: "amber", desc: "派生预览已生成，原件仍在转码校验中，尚不能作为正式源" },
  ready: { label: "完整可用", tone: "green", desc: "已通过完整性校验，原件与预览均可使用" },
  failed: { label: "失败", tone: "red", desc: "处理失败，请查看具体原因后重试或删除" }
};

export const STAGE_LABEL: Record<string, string> = {
  queued: "排队中",
  probing: "探测中",
  transcoding: "转码中",
  complete: "已完成",
  failed: "已失败",
  deleted: "已删除"
};

export function toneClasses(tone: string): string {
  switch (tone) {
    case "green":
      return "bg-emerald-50 text-emerald-700 ring-emerald-200";
    case "amber":
      return "bg-amber-50 text-amber-700 ring-amber-200";
    case "red":
      return "bg-rose-50 text-rose-700 ring-rose-200";
    case "blue":
      return "bg-blue-50 text-blue-700 ring-blue-200";
    default:
      return "bg-slate-100 text-slate-600 ring-slate-200";
  }
}

/** 将后端错误码翻译为给用户看的可定位原因。 */
export function explainErrorCode(code: string | null | undefined): string {
  switch (code) {
    case "audio_track_missing":
      return "音轨缺失：文件中没有可解码的音频流。若这是视频，请改用 .mp4 等视频格式上传。";
    case "invalid_media":
      return "媒体无法解析：文件已损坏、编码不被支持，或扩展名与实际内容不符。";
    case "transcode_failed":
      return "转码过程失败，请确认源文件可正常播放后重试。";
    case "source_file_missing":
      return "源对象文件在存储中缺失。";
    default:
      return code ?? "未知错误";
  }
}
