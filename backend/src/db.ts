import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { config } from "./config.js";
import { logger } from "./logger.js";

// 真实 PostgreSQL 连接（驱动适配层使用 pg 连接池）；不允许在业务路径中使用 mock。
const adapter = new PrismaPg({
  connectionString: config.DATABASE_URL,
  max: 10,
});

export const prisma = new PrismaClient({
  adapter,
  log: [
    { level: "warn", emit: "event" },
    { level: "error", emit: "event" },
  ],
});

prisma.$on("warn", (e) => logger.warn({ ddl: e.message }, "prisma warning"));
prisma.$on("error", (e) => logger.error({ ddl: e.message }, "prisma error"));

export type Db = typeof prisma;
