import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, VolumeX, X } from "lucide-react";
import type { AssetDTO } from "@/api/media";
import { getToken } from "@/store/authStore";
import { formatDuration, formatBytes } from "@/utils/format";
import { useStaleSnapshot } from "@/hooks/useStaleSnapshot";
import { BlobUrlKeeper } from "@/utils/blobResources";

// @ts-ignore
const API_BASE = import.meta.env.VITE_API_BASE || "/api";

/**
 * 素材预览播放器：
 * - 只播放「派生预览」，绝不把 RECEIVED/unknown 原件当正式源；
 * - 关闭/切换时释放 <video>/<audio>、撤销 objectURL（防内存泄漏）；
 * - 用快照版本（updatedAt）丢弃「预览切换后到达的旧回调」。
 */
export default function MediaPlayer({ asset, onClose }: { asset: AssetDTO; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  // 陈旧回调防护：只采纳同一素材且版本不回退的快照（预览切换后旧回调到达 → 丢弃）
  const snapshot = useStaleSnapshot<AssetDTO>(asset) ?? asset;
  const keeperRef = useRef(new BlobUrlKeeper());

  useEffect(() => {
    let revoke: string | null = null;
    setLoading(true);
    setLoadError(null);

    const kind = snapshot.kind;
    const derivKind = kind === "video" ? "video-preview" : kind === "audio" ? "audio-preview" : null;
    const deriv = derivKind ? snapshot.derivatives.find((d) => d.kind === derivKind) : null;

    // 半成品防线：未达到 PREVIEWABLE/READY 或无派生预览 → 不发请求、不挂原件
    const canPlayPreview =
      (snapshot.status === "PREVIEWABLE" || snapshot.status === "READY") && !!deriv;

    async function load() {
      if (kind === "image") {
        // 图片用缩略图/源均可（源浏览器原生可渲染）
        const thumb = snapshot.derivatives.find((d) => d.kind === "thumbnail");
        const url = thumb ? `${API_BASE}${thumb.url}` : `${API_BASE}${snapshot.sourceUrl}`;
        const res = await authed(url);
        if (!res.ok) {
          setLoadError(`图片加载失败 HTTP ${res.status}`);
          setLoading(false);
          return;
        }
        const blob = await res.blob();
        const u = keeperRef.current.replace(blob);
        revoke = u;
        setObjectUrl(u);
        setLoading(false);
        return;
      }
      if (!canPlayPreview || !derivKind) {
        setLoading(false);
        return;
      }
      const res = await authed(`${API_BASE}/blobs/derivative/${snapshot.id}/${derivKind}`);
      if (!res.ok) {
        setLoadError(`预览源不可用 HTTP ${res.status}（素材状态 ${snapshot.status}）`);
        setLoading(false);
        return;
      }
      const blob = await res.blob();
      const u = keeperRef.current.replace(blob);
      revoke = u;
      setObjectUrl(u);
      setLoading(false);
    }
    void load();

    return () => {
      // 释放媒体资源：暂停、清空 src、load() 释放解码缓冲，撤销 objectURL
      const v = videoRef.current;
      const a = audioRef.current;
      if (v) {
        v.pause();
        v.removeAttribute("src");
        v.load();
      }
      if (a) {
        a.pause();
        a.removeAttribute("src");
        a.load();
      }
      keeperRef.current.revoke();
      setObjectUrl(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.id, snapshot.status, snapshot.updatedAt]);

  const failed = snapshot.status === "FAILED";
  const processing = snapshot.status === "RECEIVED" || snapshot.status === "unknown";
  const showVideo = snapshot.kind === "video" && (snapshot.status === "PREVIEWABLE" || snapshot.status === "READY");
  const showAudio = snapshot.kind === "audio" && (snapshot.status === "PREVIEWABLE" || snapshot.status === "READY");
  const showImage = snapshot.kind === "image" && !!objectUrl && !loadError;
  const poster = snapshot.posterUrl ? `${API_BASE}${snapshot.posterUrl}` : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-3xl rounded-2xl bg-white shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
          <div className="min-w-0">
            <p className="font-semibold text-slate-900 truncate">{snapshot.filename}</p>
            <p className="text-xs text-slate-400">
              {snapshot.kind} · {formatBytes(snapshot.size)}
              {snapshot.durationMs ? ` · ${formatDuration(snapshot.durationMs)}` : ""} · 探测
              {snapshot.probeMode === "sync" ? "同步" : "异步"}
              {snapshot.probeMs != null ? ` ${snapshot.probeMs}ms` : ""}
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500" aria-label="关闭播放器">
            <X size={18} />
          </button>
        </div>

        <div className="bg-slate-950 aspect-video flex items-center justify-center relative">
          {loading && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-300 gap-2">
              <Loader2 className="animate-spin" />
              <span className="text-sm">正在准备预览源…</span>
            </div>
          )}

          {failed && (
            <FailurePanel code={snapshot.errorCode} message={snapshot.errorMessage} />
          )}

          {!failed && processing && (
            <div className="text-center text-slate-300 px-6">
              <Loader2 className="mx-auto animate-spin mb-2" />
              <p className="text-sm font-medium">原件已收（RECEIVED），转码尚未完成</p>
              <p className="text-xs text-slate-400 mt-1">播放器不会把未转码的原件当正式源，请稍后在列表重新打开</p>
            </div>
          )}

          {!failed && snapshot.status === "PREVIEWABLE" && snapshot.kind === "video" && !showVideo && (
            <div className="text-center text-slate-300 px-6">
              <p className="text-sm">已可预览封面，可播放预览仍在生成…</p>
            </div>
          )}

          {showImage && objectUrl && (
            <img src={objectUrl ?? undefined} alt={snapshot.filename} className="max-h-full max-w-full object-contain" />
          )}

          {showVideo && (
            <video
              ref={videoRef}
              key={snapshot.id}
              src={objectUrl ?? undefined}
              controls
              playsInline
              poster={poster ?? undefined}
              className="max-h-full max-w-full w-full h-full object-contain"
              onError={() => setLoadError("视频预览解码失败")}
            />
          )}
          {showAudio && (
            <div className="w-full px-8 py-12">
              {snapshot.derivatives.find((d) => d.kind === "waveform") && (
                <img
                  src={`${API_BASE}${snapshot.derivatives.find((d) => d.kind === "waveform")!.url}`}
                  alt="waveform"
                  className="w-full rounded-xl opacity-90"
                />
              )}
              <audio
                ref={audioRef}
                key={snapshot.id}
                src={objectUrl ?? undefined}
                controls
                className="w-full mt-4"
                onError={() => setLoadError("音频预览解码失败")}
              />
            </div>
          )}
          {loadError && (
            <div className="absolute bottom-3 left-3 right-3 text-sm text-rose-200 bg-rose-900/70 rounded-lg px-3 py-2">
              {loadError}
            </div>
          )}
        </div>

        <div className="px-5 py-3 flex flex-wrap items-center gap-3 text-sm">
          <StatusBadge status={snapshot.status} />
          {snapshot.kind === "video" && !snapshot.hasAudio && snapshot.status !== "FAILED" && (
            <span className="inline-flex items-center gap-1 text-amber-600 bg-amber-50 border border-amber-200 px-2 py-1 rounded-lg text-xs">
              <VolumeX size={13} /> 该视频不含音轨（不影响画面预览）
            </span>
          )}
          {snapshot.errorCode === "NO_AUDIO_STREAM" && snapshot.kind === "video" && null}
          <a
            href={`${API_BASE}${snapshot.sourceUrl}`}
            onClick={async (e) => {
              // 源文件同样需要鉴权头，使用 fetch 转 blob 后打开
              e.preventDefault();
              const res = await authed(`${API_BASE}${snapshot.sourceUrl}`);
              if (res.ok) {
                const b = await res.blob();
                const u = URL.createObjectURL(b);
                window.open(u, "_blank");
                setTimeout(() => URL.revokeObjectURL(u), 60_000);
              }
            }}
            className="ml-auto text-primary hover:underline text-xs"
          >
            下载原始文件
          </a>
        </div>
      </div>
    </div>
  );
}

function FailurePanel({ code, message }: { code: string | null; message: string | null }) {
  const hint: Record<string, string> = {
    NO_MEDIA_STREAM: "文件里检测不到任何音视频/图像流，可能已损坏或格式不受支持。",
    PROBE_FAILED: "服务端无法解析该容器，建议用标准 H.264/AAC 或 PNG/JPEG 重新导出。",
    UNSUPPORTED_CONTAINER: "容器封装不受支持，请转封装为 MP4/M4A 等标准格式。",
    TRANSCODE_FAILED: "转码过程失败，可能是编码参数异常或文件不完整。",
    CANCELLED: "素材在转码完成前被删除，产物已丢弃。",
  };
  return (
    <div className="text-center px-8 max-w-lg">
      <AlertTriangle className="mx-auto h-10 w-10 text-rose-400 mb-3" />
      <p className="text-rose-200 font-semibold">转码失败（FAILED）</p>
      <p className="text-xs text-slate-400 mt-1 font-mono">{code ?? "UNKNOWN"}</p>
      <p className="text-sm text-slate-300 mt-2">{message ?? "未知错误"}</p>
      {code && hint[code] && <p className="text-xs text-slate-400 mt-2">{hint[code]}</p>}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    RECEIVED: { label: "原件已收", cls: "bg-slate-100 text-slate-600" },
    unknown: { label: "等待探测", cls: "bg-slate-100 text-slate-600" },
    PREVIEWABLE: { label: "可预览", cls: "bg-amber-50 text-amber-700 border border-amber-200" },
    READY: { label: "完整可用", cls: "bg-emerald-50 text-emerald-700 border border-emerald-200" },
    FAILED: { label: "失败", cls: "bg-rose-50 text-rose-700 border border-rose-200" },
  };
  const m = map[status] ?? map.RECEIVED;
  return <span className={`px-2 py-1 rounded-lg text-xs font-medium ${m.cls}`}>{m.label}</span>;
}

async function authed(url: string): Promise<Response> {
  return fetch(url, { headers: { Authorization: `Bearer ${getToken() ?? ""}` } });
}
