import type { Asset } from "@/api/types";
import { formatBytes, formatDuration, STATUS_META, STAGE_LABEL, toneClasses } from "@/utils/format";
import { streamUrl } from "@/api/media";

interface Props {
  asset: Asset;
  projectId: number;
  selected: boolean;
  onSelect: () => void;
}

const TYPE_ICON: Record<string, string> = { video: "🎬", audio: "🎵", image: "🖼" };

const AssetCard = ({ asset, projectId, selected, onSelect }: Props) => {
  const token = localStorage.getItem("park_media_token") ?? "";
  const meta = STATUS_META[asset.status];
  const cover =
    asset.coverReady && asset.status !== "failed"
      ? `${streamUrl(projectId, asset.id, "cover")}?token=${encodeURIComponent(token)}`
      : null;
  const previewImage =
    asset.mediaType === "image" && asset.previewReady
      ? `${streamUrl(projectId, asset.id, "preview")}?token=${encodeURIComponent(token)}`
      : null;

  return (
    <button
      type="button"
      data-asset-id={asset.id}
      onClick={onSelect}
      className={`text-left rounded-2xl bg-white/85 border shadow-card overflow-hidden transition hover:-translate-y-0.5 hover:shadow-lg group ${
        selected ? "border-primary ring-2 ring-primary/30" : "border-white/70"
      }`}
    >
      <div className="relative aspect-video bg-slate-900 overflow-hidden">
        {cover || previewImage ? (
          <img
            src={(cover ?? previewImage) as string}
            alt={asset.filename}
            loading="lazy"
            className="w-full h-full object-cover group-hover:scale-105 transition duration-500"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-4xl bg-gradient-to-br from-slate-800 to-slate-900">
            {TYPE_ICON[asset.mediaType] ?? "📄"}
          </div>
        )}
        <span className="absolute top-2 left-2 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-black/55 text-white backdrop-blur">
          {TYPE_ICON[asset.mediaType]} {asset.mediaType}
        </span>
        {asset.hasAudio === false && asset.mediaType === "video" && (
          <span className="absolute top-2 right-2 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-500/90 text-white">
            无音轨
          </span>
        )}
        {asset.status === "failed" && (
          <div className="absolute inset-0 bg-rose-950/70 flex flex-col items-center justify-center text-rose-200 gap-1 px-3">
            <span className="text-2xl">⚠</span>
            <span className="text-[11px] text-center leading-snug">处理失败 · 点击查看原因</span>
          </div>
        )}
        {(asset.status === "received" || asset.status === "previewable") && (
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-2">
            <div className="h-1.5 rounded-full bg-white/25 overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-primary to-accent transition-all"
                style={{ width: `${asset.progress}%` }}
              />
            </div>
            <p className="text-[10px] text-white/90 mt-1">
              {STAGE_LABEL[asset.stage] ?? asset.stage} · {asset.progress}%
            </p>
          </div>
        )}
      </div>
      <div className="p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-slate-900 truncate" title={asset.filename}>
            {asset.filename}
          </p>
          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ring-1 ${toneClasses(meta.tone)}`}>
            {meta.label}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
          <span>{formatBytes(asset.sizeBytes)}</span>
          {asset.durationMs ? <span>· {formatDuration(asset.durationMs)}</span> : null}
          {asset.referenceCount > 0 && <span className="text-primary">· 引用 {asset.referenceCount}</span>}
        </div>
      </div>
    </button>
  );
};

export default AssetCard;
