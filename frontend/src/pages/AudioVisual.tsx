import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "react-hot-toast";
import { Radio } from "lucide-react";
import SectionCard from "@/components/SectionCard";
import ProjectBar from "@/components/audiovisual/ProjectBar";
import StatsPanel from "@/components/audiovisual/StatsPanel";
import UploadPanel from "@/components/audiovisual/UploadPanel";
import AssetGrid from "@/components/audiovisual/AssetGrid";
import MediaPlayer from "@/components/audiovisual/MediaPlayer";
import { mediaApi, type AssetDTO, type StatsDTO } from "@/api/media";
import { useAuthStore } from "@/store/authStore";

type Filter = "all" | "processing" | "ready" | "failed";

const AudioVisual = () => {
  const token = useAuthStore((s) => s.token);
  const [stats, setStats] = useState<StatsDTO | null>(null);
  const [assets, setAssets] = useState<AssetDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("all");
  const [opened, setOpened] = useState<AssetDTO | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async (showLoader = false) => {
    if (!token) return;
    if (showLoader) setLoading(true);
    try {
      const [s, items] = await Promise.all([mediaApi.stats(), mediaApi.list()]);
      setStats(s);
      setAssets(items);
    } catch {
      // 拦截器已提示
    } finally {
      if (showLoader) setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (!token) {
      setAssets([]);
      setStats(null);
      return;
    }
    void refresh(true);
  }, [token, refresh]);

  // 轮询：有处理中的素材时 2s 刷新；全部稳定后停。播放器打开时也持续更新，用于展示失败原因/进度
  useEffect(() => {
    const hasActive = assets.some((a) => a.status === "RECEIVED" || a.status === "unknown" || a.status === "PREVIEWABLE");
    if (token && hasActive) {
      pollRef.current = setInterval(() => void refresh(false), 2000);
      return () => {
        if (pollRef.current) clearInterval(pollRef.current);
      };
    }
    if (pollRef.current) clearInterval(pollRef.current);
  }, [assets, token, refresh]);

  // 打开的素材实时同步（例如删除素材时转码完成），同时保留版本防陈旧
  useEffect(() => {
    if (!opened) return;
    let stop = false;
    const t = setInterval(async () => {
      try {
        const fresh = await mediaApi.get(opened.id);
        if (!stop) setOpened(fresh);
      } catch {
        if (!stop) {
          setOpened(null);
          toast("素材已被删除或无权访问");
        }
      }
    }, 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [opened?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const onProject = useCallback(() => undefined, []);

  const handleDelete = async (a: AssetDTO) => {
    if (!window.confirm(`确认删除「${a.filename}」？正在转码的任务将被取消，无引用字节会被回收。`)) return;
    try {
      await mediaApi.remove(a.id);
      toast.success("素材已删除");
      if (opened?.id === a.id) setOpened(null);
      await refresh(false);
    } catch {
      /* toast handled */
    }
  };

  const filtered = assets.filter((a) => {
    if (filter === "processing") return a.status === "RECEIVED" || a.status === "unknown" || a.status === "PREVIEWABLE";
    if (filter === "ready") return a.status === "READY";
    if (filter === "failed") return a.status === "FAILED";
    return true;
  });

  const counts = {
    all: assets.length,
    processing: assets.filter((a) => a.status === "RECEIVED" || a.status === "unknown" || a.status === "PREVIEWABLE").length,
    ready: assets.filter((a) => a.status === "READY").length,
    failed: assets.filter((a) => a.status === "FAILED").length,
  };

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-5">
      <SectionCard
        title="视听素材服务"
        desc="Web 上传音视频/图片，查看转码进度与占用。源对象、派生预览与引用关系在后台持久化；字节按内容去重，授权与项目归属绝不共享。"
      >
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Radio size={16} className="text-primary" />
          <span>状态：原件已收（RECEIVED）→ 可预览（PREVIEWABLE）→ 完整可用（READY）/ 失败（FAILED）</span>
        </div>
      </SectionCard>

      <ProjectBar onProject={onProject} />

      {token && (
        <>
          <StatsPanel stats={stats} />
          <UploadPanel onAssetChanged={() => void refresh(false)} />

          <div className="flex flex-wrap items-center gap-2">
            {([
              ["all", `全部 ${counts.all}`],
              ["processing", `处理中 ${counts.processing}`],
              ["ready", `完整可用 ${counts.ready}`],
              ["failed", `失败 ${counts.failed}`],
            ] as Array<[Filter, string]>).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={
                  "px-3 py-1.5 rounded-full text-sm font-medium transition border " +
                  (filter === key
                    ? "bg-primary text-white border-primary"
                    : "bg-white/80 text-slate-600 border-slate-200 hover:border-primary hover:text-primary")
                }
              >
                {label}
              </button>
            ))}
          </div>

          <AssetGrid assets={filtered} loading={loading} onOpen={setOpened} onDelete={(a) => void handleDelete(a)} />
        </>
      )}

      {opened && <MediaPlayer asset={opened} onClose={() => setOpened(null)} />}
    </div>
  );
};

export default AudioVisual;
