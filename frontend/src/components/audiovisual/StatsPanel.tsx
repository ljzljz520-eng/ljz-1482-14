import type { StatsDTO } from "@/api/media";
import { formatBytes } from "@/utils/format";
import { Boxes, CheckCircle2, Loader2, AlertTriangle, HardDrive, Copy } from "lucide-react";

export default function StatsPanel({ stats }: { stats: StatsDTO | null }) {
  if (!stats) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-28 rounded-2xl bg-white/70 border border-slate-100 animate-pulse" />
        ))}
      </div>
    );
  }
  const cards = [
    {
      icon: Boxes,
      label: "素材总数",
      value: String(stats.assets.total),
      sub: `可预览 ${stats.assets.previewable} · 处理中 ${stats.assets.received}`,
      tone: "from-blue-500/10 to-blue-400/5 text-blue-600",
    },
    {
      icon: CheckCircle2,
      label: "完整可用",
      value: String(stats.assets.ready),
      sub: `转码完成，可正式使用`,
      tone: "from-emerald-500/10 to-emerald-400/5 text-emerald-600",
    },
    {
      icon: Loader2,
      label: "转码任务",
      value: String(stats.jobsRunning),
      sub: `失败 ${stats.assets.failed} 个待处理`,
      tone: "from-orange-500/10 to-orange-400/5 text-orange-600",
    },
    {
      icon: AlertTriangle,
      label: "失败素材",
      value: String(stats.assets.failed),
      sub: "点击素材可查看失败原因",
      tone: "from-rose-500/10 to-rose-400/5 text-rose-600",
    },
  ];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {cards.map((c) => (
          <div key={c.label} className="rounded-2xl bg-white/90 border border-slate-100 shadow-card p-4">
            <div className={`inline-flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br ${c.tone}`}>
              <c.icon className="h-4.5 w-4.5" size={18} />
            </div>
            <p className="mt-3 text-2xl font-bold text-slate-900 leading-none">{c.value}</p>
            <p className="mt-1 text-sm font-medium text-slate-700">{c.label}</p>
            <p className="mt-0.5 text-xs text-slate-400">{c.sub}</p>
          </div>
        ))}
      </div>
      <div className="rounded-2xl bg-white/90 border border-slate-100 shadow-card p-4">
        <div className="flex items-center gap-2 mb-3">
          <HardDrive size={16} className="text-primary" />
          <h4 className="font-semibold text-slate-900 text-sm">占用情况（项目「{stats.project.name}」）</h4>
        </div>
        <div className="grid md:grid-cols-4 gap-4 text-sm">
          <Metric label="素材逻辑体积" value={formatBytes(stats.bytes.logical)} hint="重复上传也计入" />
          <Metric
            label="去重后源字节"
            value={formatBytes(stats.bytes.uniqueSource)}
            hint={`项目内省 ${formatBytes(stats.savings.inProjectDedupBytes)}`}
            accent="text-emerald-600"
          />
          <Metric label="派生预览" value={formatBytes(stats.bytes.derivatives)} hint="缩略图/预览/波形" />
          <Metric
            label="磁盘物理占用"
            value={formatBytes(stats.bytes.physicalGlobal)}
            hint="跨项目字节全局去重"
            accent="text-primary"
          />
        </div>
        <div className="mt-3">
          <div className="flex justify-between text-xs text-slate-500 mb-1">
            <span className="inline-flex items-center gap-1"><Copy size={12} />配额使用</span>
            <span>
              {formatBytes(stats.bytes.logical + stats.bytes.derivatives)} / {formatBytes(stats.bytes.quota)}
            </span>
          </div>
          <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-primary to-accent transition-all"
              style={{
                width: `${Math.min(100, ((stats.bytes.logical + stats.bytes.derivatives) / Math.max(1, stats.bytes.quota)) * 100)}%`,
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value, hint, accent }: { label: string; value: string; hint: string; accent?: string }) {
  return (
    <div>
      <p className="text-xs text-slate-400">{label}</p>
      <p className={`text-lg font-bold mt-0.5 ${accent ?? "text-slate-900"}`}>{value}</p>
      <p className="text-xs text-slate-400 mt-0.5">{hint}</p>
    </div>
  );
}
