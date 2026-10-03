import HeroBanner from "@/components/HeroBanner";
import SectionCard from "@/components/SectionCard";
import StatCard from "@/components/StatCard";

const highlights = [
  {
    title: "湖光栈道",
    desc: "1.6km 环湖漫步，沉浸水雾与灯光艺术。",
    tag: "夜游首选"
  },
  {
    title: "云顶草坡",
    desc: "18° 坡度草坪，适合露营、飞盘与日落音乐。",
    tag: "轻野营"
  },
  {
    title: "森林书屋",
    desc: "原木阅读空间，精选自然主题阅读与咖啡。",
    tag: "静心角"
  }
];

const ParkOverview = () => {
  return (
    <div className="space-y-8 pb-12">
      <HeroBanner
        title="云溪公园：城市里的微度假目的地"
        subtitle="以湖、林、坡、光为核心意象，打造可散步、可创作、可社交的灵感场所。"
        highlight="Park Briefing"
      />
      <div className="max-w-6xl mx-auto px-4 grid md:grid-cols-3 gap-4" id="plans">
        <StatCard label="占地面积" value="2.8 km²" desc="湖区、森林区与艺术区联动" />
        <StatCard label="年访客" value="128万" desc="周末峰值 12,000 人次" />
        <StatCard label="开放时段" value="06:00 - 22:00" desc="夜间光影秀 19:30" />
      </div>
      <div className="max-w-6xl mx-auto px-4 space-y-6">
        <SectionCard
          title="特色场景"
          desc="四大体验动线，满足静谧、社交与亲子需求。"
        >
          <div className="grid md:grid-cols-3 gap-4">
            {highlights.map((item) => (
              <div
                key={item.title}
                className="p-5 rounded-2xl bg-white/80 border border-white/80 shadow-card hover:-translate-y-1 transition"
              >
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-lg font-semibold text-slate-900">{item.title}</h4>
                  <span className="px-2 py-1 rounded-full bg-primary/10 text-primary text-xs font-semibold">
                    {item.tag}
                  </span>
                </div>
                <p className="text-sm text-slate-600 leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
        </SectionCard>
        <SectionCard
          title="今日气候与客流"
          desc="实时体感与推荐时段，适配 Trae 预览数据展示。"
        >
          <div className="grid md:grid-cols-3 gap-4">
            <div className="p-4 rounded-2xl bg-gradient-to-br from-primary/10 to-white border border-white/60">
              <p className="text-sm text-slate-600">体感</p>
              <p className="text-2xl font-bold text-slate-900 mt-1">21°C · 微风</p>
              <p className="text-sm text-slate-500 mt-2">湖区湿度 63%，步行舒适。</p>
            </div>
            <div className="p-4 rounded-2xl bg-white shadow-card border border-white/60">
              <p className="text-sm text-slate-600">客流</p>
              <p className="text-2xl font-bold text-slate-900 mt-1">轻松</p>
              <p className="text-sm text-slate-500 mt-2">11:00 - 15:00 适合亲子漫步。</p>
            </div>
            <div className="p-4 rounded-2xl bg-white shadow-card border border-white/60">
              <p className="text-sm text-slate-600">推荐</p>
              <p className="text-2xl font-bold text-slate-900 mt-1">日落+光影秀</p>
              <p className="text-sm text-slate-500 mt-2">19:00 至艺术广场等待灯光开启。</p>
            </div>
          </div>
        </SectionCard>
        <SectionCard
          title="路线预设"
          desc="三种 90 分钟以内的公园体验组合。"
        >
          <div className="grid md:grid-cols-3 gap-4">
            {["湖畔摄影", "森林疗愈", "亲子探险"].map((route) => (
              <div key={route} className="p-4 rounded-2xl border border-slate-100 bg-white/80">
                <div className="flex items-center justify-between">
                  <p className="text-lg font-semibold text-slate-900">{route}</p>
                  <span className="text-xs text-primary font-semibold">90 min</span>
                </div>
                <p className="text-sm text-slate-500 mt-2 leading-relaxed">
                  沿路提供路灯、休憩座椅与补给点提示，适合首次到访。
                </p>
              </div>
            ))}
          </div>
        </SectionCard>
      </div>
    </div>
  );
};

export default ParkOverview;
