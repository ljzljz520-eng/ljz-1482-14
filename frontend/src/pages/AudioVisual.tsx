import SectionCard from "@/components/SectionCard";

const AudioVisual = () => {
  return (
    <div className="max-w-6xl mx-auto px-4 py-10 space-y-6">
      <SectionCard
        title="视听体验"
        desc="结合现场环境声、光影与视频模板，快速预览演出氛围。"
      >
        <div className="grid md:grid-cols-3 gap-4">
          {["水雾灯光", "森林白噪", "湖面反射"].map((item) => (
            <div key={item} className="p-4 rounded-2xl bg-white/80 border border-white/70 shadow-card">
              <h4 className="text-lg font-semibold text-slate-900">{item}</h4>
              <p className="text-sm text-slate-600 mt-2 leading-relaxed">实时调节亮度、色温与混响，匹配不同时间段的拍摄需求。</p>
              <div className="mt-3 h-2 rounded-full bg-slate-100">
                <div className="h-full w-2/3 rounded-full bg-gradient-to-r from-primary to-accent" />
              </div>
            </div>
          ))}
        </div>
      </SectionCard>
    </div>
  );
};

export default AudioVisual;
