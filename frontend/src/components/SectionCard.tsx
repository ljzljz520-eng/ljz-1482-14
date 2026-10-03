import { ReactNode } from "react";

interface SectionCardProps {
  title: string;
  desc: string;
  action?: ReactNode;
  children: ReactNode;
}

const SectionCard = ({ title, desc, action, children }: SectionCardProps) => (
  <section className="bg-white/80 border border-white shadow-card rounded-2xl p-6 backdrop-blur-sm">
    <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-4">
      <div>
        <h3 className="text-xl font-semibold text-slate-900">{title}</h3>
        <p className="text-sm text-slate-500 mt-1">{desc}</p>
      </div>
      {action}
    </div>
    {children}
  </section>
);

export default SectionCard;
