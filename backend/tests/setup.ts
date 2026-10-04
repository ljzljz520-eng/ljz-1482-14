import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// 测试隔离：独立存储目录与数据库，避免触碰 /app/data
const dir = join(tmpdir(), `park-media-test-${process.pid}`);
mkdirSync(dir, { recursive: true });
process.env.STORAGE_ROOT = dir;
process.env.REMOTE_ALLOW_HOSTS = "allowed.test";
