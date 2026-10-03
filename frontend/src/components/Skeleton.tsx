const Skeleton = ({ height = "h-4", className = "" }: { height?: string; className?: string }) => (
  <div className={`animate-pulse rounded-full bg-slate-200/70 ${height} ${className}`} />
);

export default Skeleton;
