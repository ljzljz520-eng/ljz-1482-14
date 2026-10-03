interface StatCardProps {
  label: string;
  value: string;
  desc: string;
}

const StatCard = ({ label, value, desc }: StatCardProps) => (
  <div className="p-4 rounded-2xl bg-white shadow-card border border-white/60 hover:-translate-y-1 transition">
    <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
    <p className="text-2xl font-bold text-slate-900 mt-2">{value}</p>
    <p className="text-sm text-slate-500 mt-1">{desc}</p>
  </div>
);

export default StatCard;
