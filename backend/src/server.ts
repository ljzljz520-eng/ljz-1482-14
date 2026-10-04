import { createApp } from "./app.js";
import { env } from "./config/env.js";
import logger from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { transcodeQueue } from "./modules/assets/worker.service.js";

async function main() {
  // 恢复进程崩溃时未完成的转码任务
  await transcodeQueue.recover();

  const app = createApp();
  const server = app.listen(env.port, () => {
    logger.info(
      {
        port: env.port,
        nodeEnv: env.nodeEnv,
        maxAssetBytes: env.maxAssetBytes,
        maxRemoteBytes: env.maxRemoteBytes,
        remoteAllowHosts: env.remoteAllowHosts
      },
      "park-media backend listening"
    );
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, "shutting down");
    server.close(() => {
      void prisma.$disconnect().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error({ err }, "failed to start server");
  process.exit(1);
});
