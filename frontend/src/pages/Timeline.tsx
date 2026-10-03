import SectionCard from "@/components/SectionCard";

const Timeline = () => {
  const events = [
    { time: "08:30", title: "湖面薄雾", detail: "逆光拍摄最佳，气温舒适" },
    { time: "15:00", title: "森林阅读", detail: "书屋日光柔和，适合访谈" },
    { time: "19:30", title: "光影秀", detail: "艺术广场灯光开启，音画同步" }
  ];

  return (
    <div className="max-w-6xl mx-auto px-4 py-10 space-y-6">
      <SectionCard
        title="时间轴"
        desc="规划拍摄与游览节奏，自动标记最佳时段。"
      >
        <div className="space-y-3">
          {events.map((e) => (
            <div key={e.time} className="p-4 rounded-2xl bg-white/80 border border-white shadow-card flex items-center gap-4">
              <div className="flex flex-col items-center">
                <span className="text-xs text-primary font-semibold">{e.time}</span>
                <span className="w-0.5 flex-1 bg-gradient-to-b from-primary/40 to-transparent" />
              </div>
              <div>
                <p className="text-lg font-semibold text-slate-900">{e.title}</p>
                <p className="text-sm text-slate-600 leading-relaxed">{e.detail}</p>
              </div>
            </div>
          ))}
        </div>
      </SectionCard>
    </div>
  );
};

export default Timeline;
