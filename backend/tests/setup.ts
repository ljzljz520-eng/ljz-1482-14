/**
 * Vitest setup：在任何业务模块 import 前启动真实 PostgreSQL 并注入环境变量。
 * 业务侧（prisma/config）在 import 时读 env，因此必须放在 setupFiles 里先执行。
 */
import { startRealPostgres } from "./_pg.js";
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

declare global {
  // eslint-disable-next-line no-var
  var __AV_PG__: { url: string; stop: () => Promise<void> } | undefined;
}

const storage = join(tmpdir(), `av-test-storage-${process.pid}`);
mkdirSync(storage, { recursive: true });

process.env.STORAGE_DIR = storage;
process.env.WORKER_ENABLED = "false";
process.env.FFMPEG_BIN = process.env.FFMPEG_BIN ?? "ffmpeg";
process.env.FFPROBE_BIN = process.env.FFPROBE_BIN ?? "ffprobe";
process.env.SYNC_PROBE_MS = "1500";
process.env.MAX_UPLOAD_BYTES = String(20 * 1024 * 1024);
process.env.MAX_REMOTE_BYTES = String(8 * 1024 * 1024);
process.env.REMOTE_ALLOWED_HOSTS = "images.unsplash.com,commondatastorage.googleapis.com,127.0.0.1,localhost";
process.env.ALLOW_PRIVATE_HOSTS = "1";
process.env.LOG_LEVEL = "error";

if (!globalThis.__AV_PG__) {
  const pg = await startRealPostgres("vitest");
  globalThis.__AV_PG__ = pg;
  process.env.DATABASE_URL = pg.url;
}

// @ts-ignore
export const testStorage = storage;
