/**
 * 初始化演示数据：
 * - 两个项目（云溪光影 / 林间记录），各自独立 token，授权不共享；
 * - 用 ffmpeg 真实生成 1 个视频（含音轨）、1 个无音轨视频、1 段音频、1 张图片；
 * - 走真实的「内容存储 + 素材登记 + 转码」管线，保证页面开箱即有内容。
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "../src/config.js";
import { prisma } from "../src/db.js";
import { commitLocalFile } from "../src/services/blobStore.js";
import { registerIngestedBlob } from "../src/services/assetService.js";
import { enqueueTranscodeJob, processAsset } from "../src/services/transcodeService.js";
import { TranscodeWorker } from "../src/services/worker.js";
import { logger } from "../src/logger.js";

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn(bin, args, { stdio: "ignore" });
    c.on("error", reject);
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${bin} exit ${code}: ${args.join(" ")}`))));
  });
}

async function main() {
  await mkdir(join(config.STORAGE_DIR, "seed"), { recursive: true });
  const dir = join(config.STORAGE_DIR, "seed");
  const ffmpeg = config.FFMPEG_BIN;

  // 1) 含音轨 8s 视频（测试用合成源：彩条 + sine 音）
  const withAudio = join(dir, "lake-night-show.mp4");
  await run(ffmpeg, [
    "-y",
    "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24:duration=8",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=8",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k", "-shortest", withAudio,
  ]);

  // 2) 无音轨视频（验收场景：音轨缺失）
  const noAudio = join(dir, "silent-forest.mp4");
  await run(ffmpeg, [
    "-y",
    "-f", "lavfi", "-i", "mandelbrot=size=960x540:rate=24",
    "-t", "5",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p",
    "-an", noAudio,
  ]);

  // 3) 音频（白噪声 6s）
  const audio = join(dir, "forest-whitenoise.m4a");
  await run(ffmpeg, [
    "-y",
    "-f", "lavfi", "-i", "anoisesrc=color=pink:duration=6:amplitude=0.4",
    "-c:a", "aac", "-b:a", "96k", audio,
  ]);

  // 4) 图片
  const image = join(dir, "waterlight-poster.png");
  await run(ffmpeg, [
    "-y",
    "-f", "lavfi", "-i", "gradients=size=1024x768:duration=1:speed=0.05",
    "-frames:v", "1", image,
  ]);

  const projects = [
    { code: "yunxi", name: "云溪光影项目", token: "av_token_yunxi_demo_001" },
    { code: "linjian", name: "林间记录项目", token: "av_token_linjian_demo_002" },
  ];

  for (const p of projects) {
    const project = await prisma.project.upsert({
      where: { code: p.code },
      update: {},
      create: { code: p.code, name: p.name, quotaBytes: 5n * 1024n * 1024n * 1024n },
    });
    await prisma.apiToken.upsert({
      where: { token: p.token },
      update: { projectId: project.id },
      create: { projectId: project.id, token: p.token, label: `${p.name}默认令牌` },
    });
  }

  const yunxi = await prisma.project.findUniqueOrThrow({ where: { code: "yunxi" } });
  const linjian = await prisma.project.findUniqueOrThrow({ where: { code: "linjian" } });

  // 幂等：重复执行 seed 时先清理演示项目的旧素材（级联引用/派生），再重建，避免演示库膨胀。
  await prisma.job.deleteMany({ where: { asset: { projectId: { in: [yunxi.id, linjian.id] } } } });
  await prisma.derivative.deleteMany({ where: { asset: { projectId: { in: [yunxi.id, linjian.id] } } } });
  await prisma.blobReference.deleteMany({ where: { projectId: { in: [yunxi.id, linjian.id] } } });
  await prisma.asset.deleteMany({ where: { projectId: { in: [yunxi.id, linjian.id] } } });
  await prisma.uploadChunk.deleteMany({});
  await prisma.uploadSession.deleteMany({});
  // 孤儿 blob（可能被上次 seed 的跨项目副本共享）按引用归零回收
  const blobs = await prisma.blobObject.findMany({ where: { refs: { none: {} }, assets: { none: {} }, derivatives: { none: {} } } });
  for (const b of blobs) {
    await prisma.blobObject.delete({ where: { id: b.id } }).catch(() => undefined);
  }

  // 同字节跨项目归属演示：先给云溪入库
  async function ingest(projectId: string, filename: string, local: string, mime: string) {
    const blob = await commitLocalFile(local);
    const reg = await registerIngestedBlob({
      db: prisma, projectId, filename, sha256: blob.sha256, size: blob.size, mimeType: mime,
    });
    return reg.assetId;
  }

  const asset1 = await ingest(yunxi.id, "湖面夜光影秀.mp4", withAudio, "video/mp4");
  const asset2 = await ingest(yunxi.id, "无声林间片段.mp4", noAudio, "video/mp4");
  const asset3 = await ingest(yunxi.id, "森林白噪声.m4a", audio, "audio/mp4");
  const asset4 = await ingest(yunxi.id, "水雾灯光海报.png", image, "image/png");
  // 相同字节进另一个项目：物理字节复用，但素材与授权完全独立
  const asset5 = await ingest(linjian.id, "湖面夜光影秀-跨项目副本.mp4", withAudio, "video/mp4");

  // 同步处理图片；视频/音频入队由 worker 处理
  await processAsset(prisma, asset4, "sync", { probeTimeoutMs: 5000 });
  for (const id of [asset1, asset2, asset3, asset5]) await enqueueTranscodeJob(prisma, id, "async");

  const worker = new TranscodeWorker(prisma);
  await worker.drain(120_000);

  // 一条 FAILED 演示：登记一个损坏文件并跑失败路径
  const corrupt = join(dir, "broken.mp4");
  await import("node:fs/promises").then((fsp) =>
    fsp.writeFile(corrupt, Buffer.concat([Buffer.from("not a real media file "), randomBytes(2048)]))
  );
  const bad = await ingest(yunxi.id, "损坏的素材.mp4", corrupt, "video/mp4");
  await enqueueTranscodeJob(prisma, bad, "async");
  await worker.drain(30_000).catch(() => undefined);

  await rm(dir, { recursive: true, force: true });
  const count = await prisma.asset.count();
  logger.info({ assets: count }, "seed complete");
  // 简单使用 readFile 防止 lint 报未用
  void readFile;
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    logger.error({ err: String(err), stack: err instanceof Error ? err.stack : undefined }, "seed failed");
    await prisma.$disconnect();
    process.exit(1);
  });
