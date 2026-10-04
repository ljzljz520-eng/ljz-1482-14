import { formatBytes } from "@/utils/format";
import type { ProjectStats } from "@/api/types";

const StatsBar = ({ stats }: { stats: ProjectStats | null }) => {
  if (!stats) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 rounded-2xl bg-white/70 animate-pulse" />
        ))}
      </div>
    );
  }
  const failed = stats.statusCounts.failed ?? 0;
  const processing = (stats.statusCounts.received ?? 0) + (stats.statusCounts.previewable ?? 0);
  const ready = stats.statusCounts.ready ?? 0;

  const cards = [
    {
      label: "素材总数",
      value: String(stats.totalAssets),
      sub: `完整可用 ${ready} · 处理中 ${processing} · 失败 ${failed}`,
      accent: "from-blue-500/10 to-blue-400/5 text-blue-700"
    },
    {
      label: "逻辑占用（原件+派生）",
      value: formatBytes(stats.logicalBytes),
      sub: `原件 ${formatBytes(stats.originalLogicalBytes)} · 派生 ${formatBytes(stats.renditionLogicalBytes)}`,
      accent: "from-indigo-500/10 to-indigo-400/5 text-indigo-700"
    },
    {
      label: "物理占用（去重后）",
      value: formatBytes(stats.physicalBytes),
      sub: "相同字节全局只存一份",
      accent: "from-emerald-500/10 to-emerald-400/5 text-emerald-700"
    },
    {
      label: "去重节省",
      value: formatBytes(stats.deduplicatedSavings),
      sub: `远程抓取任务 ${stats.remoteFetchCount} 次`,
      accent: "from-amber-500/10 to-amber-400/5 text-amber-700"
    }
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map((card) => (
        <div
          key={card.label}
          className={`rounded-2xl p-4 bg-gradient-to-br ${card.accent} border border-white/60 shadow-card`}
        >
          <p className="text-xs font-medium opacity-80">{card.label}</p>
          <p className="text-xl md:text-2xl font-bold mt-1 text-slate-900">{card.value}</p>
          <p className="text-[11px] text-slate-500 mt-1 leading-snug">{card.sub}</p>
        </div>
      ))}
    </div>
  );
};

export default StatsBar;
