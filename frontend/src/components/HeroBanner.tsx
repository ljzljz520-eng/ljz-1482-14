interface HeroBannerProps {
  title: string;
  subtitle: string;
  highlight?: string;
  ctaLabel?: string;
  ctaHref?: string;
}

const HeroBanner = ({ title, subtitle, highlight, ctaLabel, ctaHref = "#" }: HeroBannerProps) => (
  <section id="hero" className="relative overflow-hidden">
    <div className="absolute inset-0 bg-hero-gradient opacity-70" aria-hidden />
    <div className="relative max-w-6xl mx-auto px-4 py-16 md:py-20 flex flex-col gap-8 md:flex-row md:items-center">
      <div className="flex-1 space-y-4">
        {highlight && (
          <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/70 text-primary text-xs font-semibold shadow-sm">
            {highlight}
          </span>
        )}
        <h2 className="text-3xl md:text-4xl font-bold text-slate-900 leading-tight">
          {title}
        </h2>
        <p className="text-lg text-slate-600 leading-relaxed">{subtitle}</p>
        {ctaLabel && (
          <a
            href={ctaHref}
            className="inline-flex items-center gap-2 px-5 py-3 rounded-full bg-primary text-white font-semibold shadow-card hover:-translate-y-0.5 transition"
          >
            {ctaLabel}
          </a>
        )}
      </div>
      <div className="flex-1 grid grid-cols-2 gap-4">
        {["生态秘境", "湖光栈道", "艺术广场", "夜间光影"].map((tag) => (
          <div
            key={tag}
            className="rounded-2xl bg-white/80 border border-white shadow-card p-4 backdrop-blur-sm hover:-translate-y-1 transition"
          >
            <p className="text-sm text-slate-500">特色</p>
            <p className="text-lg font-semibold text-slate-900">{tag}</p>
          </div>
        ))}
      </div>
    </div>
  </section>
);

export default HeroBanner;
