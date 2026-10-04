import { useEffect, useMemo, useRef, useState } from "react";
import { streamUrl } from "@/api/media";
import type { Asset } from "@/api/types";
import { explainErrorCode } from "@/utils/format";

interface Props {
  asset: Asset;
  projectId: number;
}

type Source = "preview" | "original";

/**
 * 素材播放器。
 * 安全规则：
 *  - 只有 ready 素材允许切换到“原件”正式源；previewable 只能播派生预览；
 *  - failed 不渲染任何媒体，直接展示可定位的失败原因；
 *  - 卸载/切换素材/切换源时释放底层媒体资源（pause + removeAttribute + load()，
 *    释放缓冲、解码器与 Range 连接），避免长时间浏览后句柄/内存泄漏。
 */
const MediaPlayer = ({ asset, projectId }: Props) => {
  const token = localStorage.getItem("park_media_token") ?? "";
  const mediaRef = useRef<HTMLMediaElement | HTMLImageElement | null>(null);
  // 跟踪“元素是否仍连接在当前 DOM”，避免 StrictMode 双挂载的首次 cleanup 误清新元素
  const mountedElRef = useRef<HTMLMediaElement | HTMLImageElement | null>(null);
  const [source, setSource] = useState<Source>("preview");
  const [loadError, setLoadError] = useState(false);
  const [mediaReady, setMediaReady] = useState(false);

  const canPlayOriginal = asset.status === "ready";
  const effectiveSource: Source = source === "original" && !canPlayOriginal ? "preview" : source;

  const target = effectiveSource === "original" ? "original" : "preview";
  const url = asset.status === "failed" ? null : streamUrl(projectId, asset.id, target);
  const authedUrl = url ? `${url}?token=${encodeURIComponent(token)}` : null;
  const coverUrl =
    asset.coverReady && asset.mediaType === "video" && asset.status !== "failed"
      ? `${streamUrl(projectId, asset.id, "cover")}?token=${encodeURIComponent(token)}`
      : null;

  // 素材切换时默认回到预览；重置就绪态
  useEffect(() => {
    setSource("preview");
    setMediaReady(false);
    setLoadError(false);
  }, [asset.id]);

  // url 变化：重置加载态（<video src> 变化后浏览器会自动重新 load）
  useEffect(() => {
    setMediaReady(false);
    setLoadError(false);
  }, [authedUrl]);

  // 释放一个媒体元素占用的全部资源（缓冲、解码器、Range 连接）
  const releaseElement = (element: HTMLMediaElement | HTMLImageElement) => {
    if (element instanceof HTMLImageElement) {
      element.src = "";
    } else {
      const media = element as HTMLMediaElement;
      media.pause();
      media.removeAttribute("src");
      try {
        media.load();
      } catch {
        /* noop */
      }
    }
  };

  // 真正卸载时释放当前元素。用 isConnected 判断，规避 React 18 StrictMode
  // 开发期“挂载->卸载->重挂载”导致首次 cleanup 误清新元素的问题。
  useEffect(() => {
    return () => {
      const element = mountedElRef.current;
      if (element && !element.isConnected) {
        releaseElement(element);
      }
      mountedElRef.current = null;
    };
  }, []);

  const attachRef = (el: HTMLMediaElement | HTMLImageElement | null) => {
    mediaRef.current = el;
    mountedElRef.current = el;
  };

  if (asset.status === "failed") {
    return <FailurePanel asset={asset} />;
  }

  if (!asset.previewReady && asset.status === "received") {
    return (
      <div className="aspect-video w-full rounded-2xl bg-slate-900/90 flex flex-col items-center justify-center text-slate-300 gap-3">
        <div className="h-9 w-9 rounded-full border-2 border-slate-600 border-t-white animate-spin" />
        <p className="text-sm">原件已收，等待完整性探测与预览生成…</p>
        <p className="text-xs text-slate-500">半成品不会作为正式源播放</p>
      </div>
    );
  }

  const readyBadge =
    mediaReady && !loadError ? null : (
      <div className="absolute inset-0 flex items-center justify-center bg-slate-900/30 pointer-events-none">
        <div className="h-8 w-8 rounded-full border-2 border-white/40 border-t-white animate-spin" />
      </div>
    );

  return (
    <div className="space-y-3">
      <div className="relative rounded-2xl overflow-hidden bg-black/90 shadow-inner">
        {asset.mediaType === "audio" ? (
          <div className="aspect-[16/9] flex flex-col items-center justify-center gap-5 bg-gradient-to-br from-slate-900 via-slate-800 to-primary/30">
            <div className="h-20 w-20 rounded-full bg-white/10 backdrop-blur flex items-center justify-center text-4xl">
              🎵
            </div>
            <audio
              ref={(el) => attachRef(el)}
              src={authedUrl ?? undefined}
              controls
              preload="metadata"
              onLoadedMetadata={() => setMediaReady(true)}
              onError={() => setLoadError(true)}
              className="w-4/5 max-w-md"
            />
          </div>
        ) : asset.mediaType === "image" ? (
          <img
            ref={(el) => attachRef(el)}
            src={authedUrl ?? undefined}
            alt={asset.filename}
            onLoad={() => setMediaReady(true)}
            onError={() => setLoadError(true)}
            className="w-full max-h-[420px] object-contain bg-[radial-gradient(circle,#1e293b,#0f172a)]"
          />
        ) : (
          <video
            ref={(el) => attachRef(el)}
            src={authedUrl ?? undefined}
            poster={coverUrl ?? undefined}
            controls
            preload="metadata"
            playsInline
            onLoadedMetadata={() => setMediaReady(true)}
            onCanPlay={() => setMediaReady(true)}
            onError={() => setLoadError(true)}
            className="w-full max-h-[420px] bg-black"
          />
        )}
        {readyBadge}
        {loadError && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-900/85 text-center px-6">
            <div>
              <p className="text-rose-300 font-semibold text-sm">媒体加载失败</p>
              <p className="text-slate-400 text-xs mt-1">
                可能预览尚未就绪或网络中断，请稍后重试；若素材已失败请查看失败原因。
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-xs">
          {asset.status === "previewable" && (
            <span className="px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 ring-1 ring-amber-200 font-medium">
              当前：派生预览（原件转码中，暂不提供正式源）
            </span>
          )}
          {asset.hasAudio === false && asset.mediaType === "video" && (
            <span className="px-2.5 py-1 rounded-full bg-slate-100 text-slate-600 ring-1 ring-slate-200">
              该视频无音轨
            </span>
          )}
        </div>
        <div className="inline-flex rounded-xl bg-slate-100 p-1 text-xs font-medium">
          <button
            type="button"
            onClick={() => setSource("preview")}
            className={`px-3 py-1.5 rounded-lg transition ${
              effectiveSource === "preview" ? "bg-white shadow text-primary" : "text-slate-500 hover:text-slate-700"
            }`}
          >
            派生预览
          </button>
          <button
            type="button"
            disabled={!canPlayOriginal}
            title={canPlayOriginal ? "播放通过校验的原件" : "原件尚未通过完整性校验"}
            onClick={() => canPlayOriginal && setSource("original")}
            className={`px-3 py-1.5 rounded-lg transition ${
              effectiveSource === "original" ? "bg-white shadow text-primary" : "text-slate-500 hover:text-slate-700"
            } disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            原件正式源
          </button>
        </div>
      </div>
    </div>
  );
};

const FailurePanel = ({ asset }: { asset: Asset }) => (
  <div className="rounded-2xl border border-rose-200 bg-rose-50/70 p-6">
    <div className="flex items-start gap-3">
      <span className="h-10 w-10 shrink-0 rounded-xl bg-rose-100 text-rose-600 flex items-center justify-center text-lg">
        ⚠
      </span>
      <div className="min-w-0">
        <p className="font-semibold text-rose-800 text-sm">素材处理失败，无法播放</p>
        <p className="text-xs text-rose-700 mt-1 font-medium">{explainErrorCode(asset.errorCode)}</p>
        {asset.errorMessage && (
          <pre className="mt-3 whitespace-pre-wrap break-words text-[11px] leading-relaxed bg-white/70 rounded-lg p-3 text-slate-600 border border-rose-100 max-h-40 overflow-auto">
            {asset.errorMessage}
          </pre>
        )}
        <p className="text-[11px] text-rose-400 mt-2">错误码：{asset.errorCode ?? "UNKNOWN"}</p>
      </div>
    </div>
  </div>
);

export default MediaPlayer;
