import { buildApp } from "./app.js";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { logger } from "./logger.js";
import { startWorkerIfEnabled } from "./services/worker.js";

async function main() {
  const app = await buildApp();
  await app.listen({ host: config.HOST, port: config.PORT });
  logger.info({ port: config.PORT, host: config.HOST }, "audiovisual asset service listening");

  const worker = startWorkerIfEnabled(prisma);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    worker?.stop();
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error({ err: String(err), stack: err instanceof Error ? err.stack : undefined }, "fatal boot error");
  process.exit(1);
});
