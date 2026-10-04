import { Film, Music, Image as ImageIcon, Trash2, RefreshCw, Lock } from "lucide-react";
import type { AssetDTO } from "@/api/media";
import { formatBytes, formatDuration } from "@/utils/format";
import { StatusBadge } from "./MediaPlayer";
import { getToken } from "@/store/authStore";
import { useEffect, useState } from "react";

// @ts-ignore
const API_BASE = import.meta.env.VITE_API_BASE || "/api";

const KIND_ICON = { video: Film, audio: Music, image: ImageIcon } as const;

export default function AssetGrid({
  assets,
  loading,
  onOpen,
  onDelete,
}: {
  assets: AssetDTO[];
  loading: boolean;
  onOpen: (a: AssetDTO) => void;
  onDelete: (a: AssetDTO) => void;
}) {
  if (loading) {
    return (
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="rounded-2xl bg-white/70 border border-slate-100 overflow-hidden">
            <div className="aspect-video bg-slate-100 animate-pulse" />
            <div className="p-3 space-y-2">
              <div className="h-4 w-3/4 bg-slate-100 rounded animate-pulse" />
              <div className="h-3 w-1/2 bg-slate-100 rounded animate-pulse" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (assets.length === 0) {
    return (
      <div className="rounded-2xl border-2 border-dashed border-slate-200 bg-white/60 p-12 text-center">
        <Film className="mx-auto h-10 w-10 text-slate-300" />
        <p className="mt-3 text-slate-500 font-medium">还没有素材</p>
        <p className="text-sm text-slate-400 mt-1">上传音视频/图片或从白名单远程链接导入，转码完成后会出现在这里。</p>
      </div>
    );
  }
  return (
    <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {assets.map((a) => (
        <AssetCard key={a.id} asset={a} onOpen={onOpen} onDelete={onDelete} />
      ))}
    </div>
  );
}

function AssetCard({
  asset,
  onOpen,
  onDelete,
}: {
  asset: AssetDTO;
  onOpen: (a: AssetDTO) => void;
  onDelete: (a: AssetDTO) => void;
}) {
  const Icon = (KIND_ICON as Record<string, typeof Film>)[asset.kind] ?? Film;
  const [posterUrl, setPosterUrl] = useState<string | null>(null);
  const [posterError, setPosterError] = useState(false);

  // 缩略图需鉴权：用 fetch + objectURL，组件卸载时释放
  useEffect(() => {
    let revoked = false;
    let url: string | null = null;
    const thumb = asset.derivatives.find((d) => d.kind === "thumbnail");
    if (!thumb || !asset.playable) {
      setPosterUrl(null);
      return;
    }
    fetch(`${API_BASE}${thumb.url}`, { headers: { Authorization: `Bearer ${getToken() ?? ""}` } })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((b) => {
        url = URL.createObjectURL(b);
        if (!revoked) setPosterUrl(url);
        else URL.revokeObjectURL(url);
      })
      .catch(() => setPosterError(true));
    return () => {
      revoked = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [asset.id, asset.status, asset.derivatives, asset.playable]);

  const progress = asset.job?.progress;
  return (
    <div className="group rounded-2xl bg-white/90 border border-slate-100 shadow-card overflow-hidden hover:-translate-y-0.5 transition">
      <button
        onClick={() => onOpen(asset)}
        className="relative block w-full aspect-video bg-slate-900 overflow-hidden text-left"
      >
        {posterUrl && !posterError ? (
          <img src={posterUrl} alt={asset.filename} className="w-full h-full object-cover opacity-90 group-hover:opacity-100 transition" />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-slate-800 to-slate-900">
            <Icon className="h-10 w-10 text-slate-500" />
          </div>
        )}
        <div className="absolute top-2 left-2">
          <StatusBadge status={asset.status} />
        </div>
        <span className="absolute top-2 right-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-slate-900/70 text-slate-200 text-[10px]">
          <Lock size={10} /> 项目隔离
        </span>
        {(asset.status === "RECEIVED" || asset.status === "unknown" || (asset.status === "PREVIEWABLE" && asset.kind !== "image")) && (
          <div className="absolute bottom-0 inset-x-0 p-2 bg-gradient-to-t from-slate-900/90 to-transparent">
            {asset.status === "RECEIVED" || asset.status === "unknown" ? (
              <div className="flex items-center gap-2 text-xs text-slate-200">
                <RefreshCw size={12} className="animate-spin" />
                转码排队/探测中…
              </div>
            ) : (
              <div className="text-xs text-amber-200">可预览封面，正式预览转码中…</div>
            )}
            {typeof progress === "number" && (
              <div className="mt-1 h-1 rounded-full bg-white/20 overflow-hidden">
                <div className="h-full bg-gradient-to-r from-primary to-accent" style={{ width: `${progress}%` }} />
              </div>
            )}
          </div>
        )}
        {asset.status === "FAILED" && (
          <div className="absolute bottom-2 left-2 right-2 text-xs text-rose-200 bg-rose-900/80 rounded-md px-2 py-1 truncate">
            {asset.errorMessage ?? asset.errorCode ?? "转码失败"}
          </div>
        )}
        {asset.kind === "video" && !asset.hasAudio && asset.status !== "FAILED" && (
          <span className="absolute bottom-2 right-2 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/90 text-white">无音轨</span>
        )}
      </button>
      <div className="p-3">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium text-slate-800 truncate" title={asset.filename}>
            {asset.filename}
          </p>
          <button
            onClick={() => onDelete(asset)}
            className="p-1 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-rose-50 transition shrink-0"
            title="删除素材"
          >
            <Trash2 size={15} />
          </button>
        </div>
        <div className="mt-1 flex items-center justify-between text-xs text-slate-400">
          <span>
            {formatBytes(asset.size)}
            {asset.durationMs ? ` · ${formatDuration(asset.durationMs)}` : ""}
          </span>
          <span className="font-mono">{asset.sha256.slice(0, 8)}</span>
        </div>
      </div>
    </div>
  );
}
