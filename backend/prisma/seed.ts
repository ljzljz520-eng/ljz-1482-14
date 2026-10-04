/**
 * 初始化数据：用户、项目、成员关系。
 * 媒体演示素材在容器启动后由后台脚本生成并走真实上传/转码流水线入库，
 * 保证“空库不交付”，同时演示数据本身也是真实记录。
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash("123456", 10);

  const admin = await prisma.user.upsert({
    where: { username: "admin" },
    update: {},
    create: { username: "admin", passwordHash, displayName: "园区管理员", role: "admin" }
  });
  const editor = await prisma.user.upsert({
    where: { username: "editor" },
    update: {},
    create: { username: "editor", passwordHash, displayName: "内容编辑", role: "member" }
  });
  const viewer = await prisma.user.upsert({
    where: { username: "viewer" },
    update: {},
    create: { username: "viewer", passwordHash, displayName: "访客", role: "member" }
  });

  const light = await prisma.project.upsert({
    where: { key: "night-light" },
    update: {},
    create: { key: "night-light", name: "夜间光影秀" }
  });
  const forest = await prisma.project.upsert({
    where: { key: "forest-sound" },
    update: {},
    create: { key: "forest-sound", name: "森林白噪音" }
  });

  const memberships = [
    { userId: admin.id, projectId: light.id, role: "owner" },
    { userId: editor.id, projectId: light.id, role: "editor" },
    { userId: viewer.id, projectId: light.id, role: "viewer" },
    { userId: admin.id, projectId: forest.id, role: "owner" },
    { userId: editor.id, projectId: forest.id, role: "editor" }
  ];
  for (const m of memberships) {
    await prisma.projectMember.upsert({
      where: { userId_projectId: { userId: m.userId, projectId: m.projectId } },
      update: { role: m.role },
      create: m
    });
  }

  console.log("seed users/projects done:", {
    users: [admin.username, editor.username, viewer.username],
    projects: [light.key, forest.key]
  });
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
