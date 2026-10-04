/**
 * 演示素材初始化：用系统 ffmpeg 在临时目录生成几份真实媒体，
 * 然后走与线上完全一致的服务流水线（登记 blob -> 建素材 -> 转码派生）入库，
 * 保证“空库不交付”，且演示数据就是真实可播放记录。
 * 已存在同名演示素材时跳过，保证重复执行幂等。
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { registerBlob } from "../src/modules/assets/blob.service.js";
import { processAsset } from "../src/modules/assets/transcode.service.js";
import { guessMime, guessMediaKind } from "../src/modules/uploads/upload.service.js";

const prisma = new PrismaClient();

function ffmpeg(args: string[]) {
  execFileSync("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
}

async function ensureDemoAsset(opts: {
  projectKey: string;
  username: string;
  filename: string;
  build: (path: string) => void;
}) {
  const project = await prisma.project.findUnique({ where: { key: opts.projectKey } });
  const user = await prisma.user.findUnique({ where: { username: opts.username } });
  if (!project || !user) {
    console.log(`skip ${opts.filename}: project/user missing`);
    return;
  }
  const exists = await prisma.asset.findFirst({
    where: { projectId: project.id, filename: opts.filename, deletedAt: null }
  });
  if (exists) {
    console.log(`skip ${opts.filename}: already exists (asset ${exists.id})`);
    return;
  }

  const dir = "/tmp/seed-media";
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, opts.filename);
  opts.build(filePath);

  const size = readFileSync(filePath).length;
  const mime = guessMime(opts.filename);
  const blob = await registerBlob({ tmpPath: filePath, sizeBytes: size, mimeType: mime });

  const asset = await prisma.asset.create({
    data: {
      projectId: project.id,
      uploaderId: user.id,
      originalBlobId: blob.id,
      filename: opts.filename,
      mediaType: guessMediaKind(opts.filename),
      status: "received",
      stage: "queued",
      sizeBytes: size,
      source: "upload",
      probeMode: "async"
    }
  });
  // 同步走完整转码（seed 阶段一次性完成，页面打开即有“完整可用”演示内容）
  await processAsset(asset.id, asset.jobGeneration);
  console.log(`seeded ${opts.filename} -> asset ${asset.id}`);
}

async function main() {
  await ensureDemoAsset({
    projectKey: "night-light",
    username: "admin",
    filename: "湖面光影-开场.mp4",
    build: (p) =>
      ffmpeg([
        "-f", "lavfi", "-i", "testsrc=duration=6:size=1280x720:rate=24",
        "-f", "lavfi", "-i", "sine=frequency=523:duration=6",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "26",
        "-c:a", "aac", "-shortest", p, "-y"
      ])
  });

  await ensureDemoAsset({
    projectKey: "night-light",
    username: "editor",
    filename: "水雾灯光-无音轨样片.mp4",
    build: (p) =>
      ffmpeg([
        "-f", "lavfi", "-i", "testsrc=duration=4:size=854x480:rate=15",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "28",
        p, "-y"
      ])
  });

  await ensureDemoAsset({
    projectKey: "forest-sound",
    username: "admin",
    filename: "森林白噪-清晨.m4a",
    build: (p) =>
      ffmpeg(["-f", "lavfi", "-i", "anoisesrc=d=6:c=pink:a=0.15", "-c:a", "aac", "-b:a", "128k", p, "-y"])
  });

  await ensureDemoAsset({
    projectKey: "forest-sound",
    username: "editor",
    filename: "林间栈道.jpg",
    build: (p) =>
      ffmpeg(["-f", "lavfi", "-i", "color=c=0x2e7d4f:s=960x600:d=1", "-frames:v", "1", p, "-y"])
  });

  // 一条演示引用关系
  const project = await prisma.project.findUnique({ where: { key: "night-light" } });
  const asset = project
    ? await prisma.asset.findFirst({ where: { projectId: project.id, filename: "湖面光影-开场.mp4" } })
    : null;
  const admin = await prisma.user.findUnique({ where: { username: "admin" } });
  if (project && asset && admin) {
    await prisma.assetReference.upsert({
      where: {
        projectId_assetId_refType_refKey: {
          projectId: project.id,
          assetId: asset.id,
          refType: "scene",
          refKey: "night-show-opening"
        }
      },
      update: {},
      create: {
        projectId: project.id,
        assetId: asset.id,
        refType: "scene",
        refKey: "night-show-opening",
        label: "夜间光影秀·开场",
        createdBy: admin.id
      }
    });
  }

  if (existsSync("/tmp/seed-media")) rmSync("/tmp/seed-media", { recursive: true, force: true });
  console.log("demo media seed done");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error("seed-media failed:", err.message);
    await prisma.$disconnect();
    // 不阻断启动：seed 失败时服务本身仍应可运行
    process.exit(0);
  });
