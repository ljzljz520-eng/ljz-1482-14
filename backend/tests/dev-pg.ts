/** 本地开发辅助：启动嵌入式 PG，执行迁移，并保持运行（Ctrl+C 退出）。Docker 环境使用真实 postgres。 */
import { startRealPostgres } from "../tests/_pg.js";
const pg = await startRealPostgres("dev");
console.log("DEV_POSTGRES_URL=" + pg.url);
process.on("SIGINT", async () => { await pg.stop(); process.exit(0); });
process.on("SIGTERM", async () => { await pg.stop(); process.exit(0); });
setInterval(() => {}, 1 << 30);
