import { useRef, useState } from "react";
import { toast } from "react-hot-toast";
import { uploadChunked, recoverSession, type UploadProgress } from "@/lib/uploader";
import { useAuthStore } from "@/store/authStore";
import { formatBytes } from "@/utils/format";
import type { Asset } from "@/api/types";

interface Props {
  onUploaded: (asset: Asset) => void;
}

const ACCEPT = "video/*,audio/*,image/*";
const MAX_BYTES = 500 * 1024 * 1024;

const UploadPanel = ({ onUploaded }: Props) => {
  const projectId = useAuthStore((s) => s.currentProjectId)!;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [probeMode, setProbeMode] = useState<"sync" | "async">("async");
  const [resumeHint, setResumeHint] = useState<string | null>(null);
  const abortRef = useRef<{ aborted: boolean }>({ aborted: false });
  const busyRef = useRef(false);

  const validateFile = (file: File): string | null => {
    if (file.size <= 0) return "文件为空";
    if (file.size > MAX_BYTES)
      return `文件超过单素材上限 500MB（当前 ${formatBytes(file.size)}），已在上传前拦截`;
    const okType = file.type.startsWith("video/") || file.type.startsWith("audio/") || file.type.startsWith("image/");
    const okExt = /\.(mp4|mov|m4v|webm|mkv|avi|mp3|m4a|aac|wav|flac|ogg|opus|png|jpe?g|gif|webp|bmp|avif)$/i.test(file.name);
    if (!okType && !okExt) return "仅支持音频、视频或图片文件";
    return null;
  };

  const handleFiles = async (files: FileList | File[]) => {
    if (busyRef.current) return;
    const file = Array.from(files)[0];
    if (!file) return;
    const validationError = validateFile(file);
    if (validationError) {
      toast.error(validationError);
      return;
    }

    // 检测是否存在可恢复会话
    const recover = await recoverSession(projectId, file);
    if (recover) {
      setResumeHint(`检测到该文件已上传 ${recover.received}/${recover.total} 个分片，将断点续传`);
      toast("检测到未完成上传，自动续传", { icon: "🔄" });
    } else {
      setResumeHint(null);
    }

    busyRef.current = true;
    abortRef.current = { aborted: false };
    setProgress({ phase: "hashing", percent: 0, uploadedChunks: 0, totalChunks: 0 });
    try {
      const result = await uploadChunked({
        projectId,
        file,
        probeMode,
        resumeKey: recover?.resumeKey,
        signal: abortRef.current,
        onProgress: setProgress
      });
      if (result.resumed) toast.success("断点续传完成");
      if (result.asset.status === "ready") toast.success(`「${file.name}」已完整可用`);
      else if (result.asset.status === "failed") toast.error("上传完成，但转码失败，请查看原因");
      else toast.success("原件已收，后台正在转码");
      onUploaded(result.asset);
      setProgress(null);
      setResumeHint(null);
      if (inputRef.current) inputRef.current.value = "";
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes("已取消")) {
        toast("已暂停上传，已传分片已保留，可稍后继续");
      } else {
        toast.error(message);
      }
      setProgress((p) => (p ? { ...p, phase: "error", message } : p));
    } finally {
      busyRef.current = false;
    }
  };

  const active = progress && progress.phase !== "done" && progress.phase !== "error";
  const canPause = active && (progress.phase === "uploading" || progress.phase === "hashing" || progress.phase === "finalizing");

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        void handleFiles(e.dataTransfer.files);
      }}
      className={`rounded-3xl border-2 border-dashed p-7 text-center transition bg-white/80 ${
        dragOver ? "border-primary bg-primary/5 scale-[1.01]" : "border-slate-200"
      }`}
    >
      <div className="mx-auto h-14 w-14 rounded-2xl bg-gradient-to-br from-primary to-accent text-white flex items-center justify-center text-2xl shadow-card mb-3">
        ⬆
      </div>
      <p className="text-base font-semibold text-slate-900">拖拽音视频 / 图片到这里，或点击选择</p>
      <p className="text-xs text-slate-500 mt-1">
        分片上传 · 单文件上限 500MB · 中断后自动按对象身份与块校验续传 · 完成请求重试不会产生重复素材
      </p>
      <div className="mt-4 flex items-center justify-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={Boolean(active)}
          className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-primary to-accent text-white text-sm font-semibold shadow-card hover:opacity-90 active:scale-[0.99] transition disabled:opacity-50"
        >
          选择文件
        </button>
        <div className="inline-flex rounded-xl bg-slate-100 p-1 text-xs font-medium">
          {(["async", "sync"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              disabled={Boolean(active)}
              onClick={() => setProbeMode(mode)}
              className={`px-3 py-1.5 rounded-lg transition ${
                probeMode === mode ? "bg-white shadow text-primary" : "text-slate-500"
              } disabled:opacity-50`}
              title={mode === "sync" ? "请求内完成探测，响应即终态（适合小文件）" : "先返回原件已收，后台异步转码并推送进度"}
            >
              {mode === "sync" ? "同步探测" : "异步探测"}
            </button>
          ))}
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) void handleFiles(e.target.files);
        }}
      />

      {resumeHint && <p className="mt-3 text-xs text-amber-600 font-medium">{resumeHint}</p>}

      {progress && (
        <div className="mt-5 text-left">
          <div className="flex items-center justify-between text-xs text-slate-600 mb-1.5">
            <span className="font-medium">
              {progress.phase === "hashing" && "计算校验值…"}
              {progress.phase === "uploading" &&
                `上传分片 ${progress.uploadedChunks}/${progress.totalChunks}`}
              {progress.phase === "finalizing" && "完成校验并登记素材…"}
              {progress.phase === "done" && "完成"}
              {progress.phase === "error" && (progress.message ?? "上传中断")}
            </span>
            <span className="tabular-nums">{progress.percent}%</span>
          </div>
          <div className="h-2.5 rounded-full bg-slate-100 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-300 ${
                progress.phase === "error"
                  ? "bg-rose-400"
                  : "bg-gradient-to-r from-primary to-accent"
              }`}
              style={{ width: `${progress.percent}%` }}
            />
          </div>
          <div className="mt-3 flex justify-end gap-2">
            {canPause && (
              <button
                type="button"
                onClick={() => {
                  abortRef.current.aborted = true;
                }}
                className="px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200 text-slate-600 hover:border-rose-300 hover:text-rose-600 transition"
              >
                暂停（保留已传分片）
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default UploadPanel;
