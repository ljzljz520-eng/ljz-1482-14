import EmbeddedPostgres from "embedded-postgres";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface PgInstance {
  pg: EmbeddedPostgres;
  url: string;
  stop: () => Promise<void>;
}

/**
 * 启动一个真实的嵌入式 PostgreSQL（非 mock），按迁移目录顺序执行迁移 SQL。
 * 验收测试全程对真实数据库做读写。
 */
export async function startRealPostgres(name = "av-test"): Promise<PgInstance> {
  const dataDir = process.env.PG_DATA_DIR ?? join("/tmp", `av-pg-${name}-${process.pid}`);
  const port = Number(process.env.PG_PORT ?? 55432);
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "audiovisual",
    password: "audiovisual",
    port,
    persistent: false,
    initdbFlags: [],
    postgresFlags: [],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("audiovisual");
  const url = `postgresql://audiovisual:audiovisual@127.0.0.1:${port}/audiovisual`;
  const client = pg.getPgClient("audiovisual");
  await client.connect();
  const dir = join(__dirname, "..", "prisma", "migrations");
  for (const m of readdirSync(dir, { withFileTypes: true })) {
    if (!m.isDirectory()) continue;
    const sql = readFileSync(join(dir, m.name, "migration.sql"), "utf8");
    await client.query(sql);
  }
  await client.end();
  return {
    pg,
    url,
    stop: async () => {
      try { await pg.stop(); } catch { /* ignore */ }
    },
  };
}
