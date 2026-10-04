/**
 * 集中式环境配置，所有可调参数带安全默认值。
 */
const parseInteger = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
};

const parseList = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: parseInteger(process.env.PORT, 8080),
  databaseUrl:
    process.env.DATABASE_URL ?? "mysql://root:root@db:3306/park_media",
  jwtSecret: process.env.JWT_SECRET ?? "park-media-dev-secret-change-me",
  storageRoot: process.env.STORAGE_ROOT ?? "/app/data",
  // 单个素材大小上限（默认 500MB）
  maxAssetBytes: parseInteger(process.env.MAX_ASSET_BYTES, 500 * 1024 * 1024),
  maxRemoteBytes: parseInteger(process.env.MAX_REMOTE_BYTES, 200 * 1024 * 1024),
  maxRedirects: parseInteger(process.env.REMOTE_MAX_REDIRECTS, 3),
  // 受限下载器：仅允许访问的主机名（白名单优先）
  remoteAllowHosts: parseList(process.env.REMOTE_ALLOW_HOSTS),
  remoteFetchTimeoutMs: parseInteger(process.env.REMOTE_FETCH_TIMEOUT_MS, 30_000),
  sessionTtlHours: parseInteger(process.env.UPLOAD_SESSION_TTL_HOURS, 24),
  workerConcurrency: parseInteger(process.env.TRANSCODE_CONCURRENCY, 2),
  // 同步探测最长允许耗时，超时即回退建议客户端使用异步
  syncProbeTimeoutMs: parseInteger(process.env.SYNC_PROBE_TIMEOUT_MS, 120_000),
  logLevel: process.env.LOG_LEVEL ?? "info"
};

export const isProduction = env.nodeEnv === "production";
