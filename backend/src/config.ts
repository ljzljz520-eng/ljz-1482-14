import { z } from "zod";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

// 本地开发自动读取 backend/.env；容器中环境变量由 docker-compose 注入
const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, "..", ".env") });

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  STORAGE_DIR: z.string().default("/data/storage"),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(500 * 1024 * 1024),
  MAX_REMOTE_BYTES: z.coerce.number().int().positive().default(50 * 1024 * 1024),
  REMOTE_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  SYNC_PROBE_MS: z.coerce.number().int().positive().default(800),
  REMOTE_ALLOWED_HOSTS: z
    .string()
    .default("images.unsplash.com,commondatastorage.googleapis.com,localhost"),
  WORKER_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v !== "false" && v !== "0"),
  FFMPEG_BIN: z.string().default("ffmpeg"),
  FFPROBE_BIN: z.string().default("ffprobe"),
  LOG_LEVEL: z.string().default("info"),
  PORT: z.coerce.number().int().default(8000),
  HOST: z.string().default("0.0.0.0"),
});

export const config = envSchema.parse(process.env);

export const allowedRemoteHosts = new Set(
  config.REMOTE_ALLOWED_HOSTS.split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
);
