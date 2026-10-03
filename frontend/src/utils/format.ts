export const formatTime = (minutes: number) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}小时${m}分钟`;
};

export const formatVisitors = (num: number) => {
  if (num > 10000) return `${(num / 10000).toFixed(1)}万`;
  return `${num.toLocaleString()}人`;
};
