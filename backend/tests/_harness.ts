import { rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { startRealPostgres } from "./_pg.js";

const FFMPEG = process.env.FFMPEG_BIN ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_BIN ?? "ffprobe";

export interface Harness {
  app: FastifyInstance;
  base: (p: string) => string;
  projectA: { id: string; token: string; name: string };
  projectB: { id: string; token: string; name: string };
  close: () => Promise<void>;
}

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn(bin, args, { stdio: "ignore" });
    c.on("error", reject);
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${bin} ${args.join(" ")} -> ${code}`))));
  });
}

/**
 * 生成真实测试媒体（非 mock）：
 * - video-with-audio.mp4 / video-no-audio.mp4 / audio.m4a / image.png
 */
export async function makeFixture(
  kind: "video" | "noaudio" | "audio" | "image" | "corrupt" | "huge",
  dir: string
): Promise<{ path: string; filename: string; mime: string; size: number }> {
  const id = randomUUID().slice(0, 8);
  if (kind === "video") {
    const path = join(dir, `v-${id}.mp4`);
    await run(FFMPEG, [
      "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=20:duration=3",
      "-f", "lavfi", "-i", "sine=frequency=523:duration=3",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "32", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "64k", "-shortest", path,
    ]);
    return { path, filename: "video.mp4", mime: "video/mp4", size: (await stat(path)).size };
  }
  if (kind === "noaudio") {
    const path = join(dir, `n-${id}.mp4`);
    await run(FFMPEG, [
      "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=20:duration=2",
      "-t", "2", "-an", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "32", "-pix_fmt", "yuv420p", path,
    ]);
    return { path, filename: "noaudio.mp4", mime: "video/mp4", size: (await stat(path)).size };
  }
  if (kind === "audio") {
    const path = join(dir, `a-${id}.m4a`);
    await run(FFMPEG, [
      "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=2",
      "-c:a", "aac", "-b:a", "64k", path,
    ]);
    return { path, filename: "audio.m4a", mime: "audio/mp4", size: (await stat(path)).size };
  }
  if (kind === "image") {
    const path = join(dir, `i-${id}.png`);
    await run(FFMPEG, ["-y", "-f", "lavfi", "-i", "testsrc2=size=480x320:rate=1:duration=1", "-frames:v", "1", path]);
    return { path, filename: "image.png", mime: "image/png", size: (await stat(path)).size };
  }
  if (kind === "corrupt") {
    const path = join(dir, `c-${id}.mp4`);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, Buffer.concat([Buffer.from("garbage header "), Buffer.alloc(4096, 0x58)]));
    return { path, filename: "corrupt.mp4", mime: "video/mp4", size: 4100 };
  }
  // huge 不实际写盘，由上传测试用稀疏声明触发
  const path = join(dir, "huge.bin");
  return { path, filename: "huge.mp4", mime: "video/mp4", size: Number(process.env.TEST_MAX_UPLOAD ?? 10 * 1024 * 1024) + 1 };
}

import { stat } from "node:fs/promises";

export async function setupHarness(label: string): Promise<Harness> {
  // 真实 PG 由 tests/setup.ts 统一启动并注入 DATABASE_URL
  const { buildApp } = await import("../src/app.js");
  const { prisma } = await import("../src/db.js");
  const app = await buildApp();
  await app.ready();

  const tokenA = "test-token-A-" + randomUUID();
  const tokenB = "test-token-B-" + randomUUID();
  const pa = await prisma.project.create({ data: { code: "proj-a-" + label, name: "项目甲", quotaBytes: 1_000_000_000n } });
  const pb = await prisma.project.create({ data: { code: "proj-b-" + label, name: "项目乙", quotaBytes: 1_000_000_000n } });
  await prisma.apiToken.createMany({ data: [
    { projectId: pa.id, token: tokenA, label: "A" },
    { projectId: pb.id, token: tokenB, label: "B" },
  ]});

  return {
    app,
    base: (p: string) => `/api${p}`,
    projectA: { id: pa.id, token: tokenA, name: pa.name },
    projectB: { id: pb.id, token: tokenB, name: pb.name },
    close: async () => {
      await app.close();
      await prisma.$disconnect();
    },
  };
}

export async function authHeaders(token: string, extra: Record<string, string> = {}) {
  return { Authorization: `Bearer ${token}`, ...extra };
}
