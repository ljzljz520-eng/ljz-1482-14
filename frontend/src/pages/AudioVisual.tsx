import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuthStore } from "@/store/authStore";
import { listAssets, getStats, getAsset } from "@/api/media";
import type { Asset, ProjectStats } from "@/api/types";
import { useProjectEvents, type AssetEvent } from "@/hooks/useProjectEvents";
import UploadPanel from "@/components/UploadPanel";
import RemoteFetchPanel from "@/components/RemoteFetchPanel";
import StatsBar from "@/components/StatsBar";
import AssetCard from "@/components/AssetCard";
import AssetDrawer from "@/components/AssetDrawer";
import Skeleton from "@/components/Skeleton";

type FilterStatus = "all" | "received" | "previewable" | "ready" | "failed";
type FilterType = "all" | "video" | "audio" | "image";

const AudioVisual = () => {
  const projectId = useAuthStore((s) => s.currentProjectId);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [stats, setStats] = useState<ProjectStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<FilterStatus>("all");
  const [typeFilter, setTypeFilter] = useState<FilterType>("all");
  const [keyword, setKeyword] = useState("");
  const [liveEvent, setLiveEvent] = useState<AssetEvent | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(
    async (silent = false) => {
      if (!projectId) return;
      try {
        const data = await listAssets(projectId, { pageSize: 60 });
        setAssets(data.items);
        setStats(await getStats(projectId));
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [projectId]
  );

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  // 后台仍有处理中素材时定时兜底刷新（SSE 之外的保险，处理完即停）
  useEffect(() => {
    const hasActive = assets.some((a) => a.status === "received" || a.status === "previewable");
    if (!hasActive) {
      if (pollRef.current) clearTimeout(pollRef.current);
      return;
    }
    pollRef.current = setTimeout(() => void load(true), 5000);
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [assets, load]);

  const refreshSelected = useCallback(async () => {
    if (!selectedId || !projectId) return;
    try {
      const fresh = await getAsset(projectId, selectedId);
      setAssets((prev) => prev.map((a) => (a.id === fresh.id ? { ...a, ...fresh } : a)));
      setLiveEvent(null);
    } catch {
      /* 已删除等情况忽略 */
    }
  }, [selectedId, projectId]);

  useProjectEvents(projectId, {
    onAsset: (event) => {
      // 卡片列表的就地更新：只有同一代际才应用，旧回调丢弃
      setAssets((prev) =>
        prev.map((a) => {
          if (a.id !== event.assetId) return a;
          if (event.jobGeneration !== undefined && event.jobGeneration !== a.jobGeneration && event.status !== "ready") {
            // 代际不一致的进度事件忽略；但 ready/failed 仍需先查代际——此处保守处理交给轮询
            return a;
          }
          return {
            ...a,
            status: (event.status as Asset["status"]) ?? a.status,
            stage: event.stage ?? a.stage,
            progress: event.progress ?? a.progress,
            hasAudio: event.hasAudio ?? a.hasAudio
          };
        })
      );
      setLiveEvent(event);
      // 到达终态时拉一次完整记录（rendition / 错误详情）并刷新统计
      if (event.status === "ready" || event.status === "failed") {
        void refreshSelected();
        void load(true);
      }
    },
    onDeleted: (assetId) => {
      setAssets((prev) => prev.filter((a) => a.id !== assetId));
      setStats((s) => (s ? { ...s, totalAssets: Math.max(0, s.totalAssets - 1) } : s));
      void load(true);
      if (selectedId === assetId) setSelectedId(null);
    },
    onFetch: () => {
      // 远程抓取完成/失败后刷新列表
      void load(true);
    }
  });

  const filtered = useMemo(() => {
    return assets.filter((a) => {
      if (statusFilter !== "all" && a.status !== statusFilter) return false;
      if (typeFilter !== "all" && a.mediaType !== typeFilter) return false;
      if (keyword && !a.filename.toLowerCase().includes(keyword.toLowerCase())) return false;
      return true;
    });
  }, [assets, statusFilter, typeFilter, keyword]);

  if (!projectId) {
    return (
      <div className="max-w-6xl mx-auto px-4 py-20 text-center text-slate-500">
        你当前没有可访问的项目。
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8 space-y-6">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="h-8 w-8 rounded-xl bg-gradient-to-br from-primary to-accent text-white flex items-center justify-center text-sm">
            视
          </span>
          <h1 className="text-2xl font-bold text-slate-900">视听素材服务</h1>
        </div>
        <p className="text-sm text-slate-500 max-w-3xl leading-relaxed">
          真实素材工作台：分片上传音视频与图片，跟踪转码进度与存储占用；后台持久记录<strong>源对象、派生预览与引用关系</strong>。
          原件通过完整性校验前只是“原件已收/可预览”，播放器不会把半成品当作正式源。
        </p>
      </header>

      <StatsBar stats={stats} />

      <div className="grid lg:grid-cols-2 gap-5">
        <UploadPanel onUploaded={() => void load(true)} />
        <RemoteFetchPanel onFetched={() => void load(true)} />
      </div>

      <section className="space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h2 className="text-lg font-bold text-slate-900">素材库</h2>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索文件名"
              className="rounded-xl border border-slate-200 px-3.5 py-2 text-xs w-40 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition"
            />
            <Segmented
              value={typeFilter}
              onChange={(v) => setTypeFilter(v as FilterType)}
              options={[
                { value: "all", label: "全部" },
                { value: "video", label: "视频" },
                { value: "audio", label: "音频" },
                { value: "image", label: "图片" }
              ]}
            />
            <Segmented
              value={statusFilter}
              onChange={(v) => setStatusFilter(v as FilterStatus)}
              options={[
                { value: "all", label: "全部状态" },
                { value: "received", label: "原件已收" },
                { value: "previewable", label: "可预览" },
                { value: "ready", label: "完整可用" },
                { value: "failed", label: "失败" }
              ]}
            />
          </div>
        </div>

        {loading ? (
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-44 rounded-2xl" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-slate-200 bg-white/60 py-16 text-center">
            <p className="text-3xl mb-2">📂</p>
            <p className="text-sm text-slate-500">
              {assets.length === 0 ? "还没有素材，上传第一个音视频或图片开始吧" : "没有符合筛选条件的素材"}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4">
            {filtered.map((asset) => (
              <AssetCard
                key={asset.id}
                asset={asset}
                projectId={projectId}
                selected={selectedId === asset.id}
                onSelect={() => setSelectedId(asset.id)}
              />
            ))}
          </div>
        )}
      </section>

      <AssetDrawer
        projectId={projectId}
        assetId={selectedId}
        onClose={() => setSelectedId(null)}
        onChanged={() => void load(true)}
        liveEvent={liveEvent}
      />
    </div>
  );
};

const Segmented = ({
  value,
  onChange,
  options
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) => (
  <div className="inline-flex rounded-xl bg-slate-100 p-1 text-xs font-medium flex-wrap">
    {options.map((opt) => (
      <button
        key={opt.value}
        type="button"
        onClick={() => onChange(opt.value)}
        className={`px-2.5 py-1.5 rounded-lg transition ${
          value === opt.value ? "bg-white shadow text-primary" : "text-slate-500 hover:text-slate-700"
        }`}
      >
        {opt.label}
      </button>
    ))}
  </div>
);

export default AudioVisual;
