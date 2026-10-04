import { prisma } from "../../lib/prisma.js";

/**
 * 项目占用统计：
 * - 原件逻辑占用：本项目所有源对象名义大小之和（用户视角：我传了多少）；
 * - 派生逻辑占用：预览/封面名义大小之和；
 * - 物理占用：上述引用到的 distinct blob 实际大小之和（相同字节只算一次）；
 * - 去重节省 = 逻辑总和 - 物理实际。
 */
export async function projectStats(projectId: number) {
  const [statusGroups, typeGroups, fetchCount] = await Promise.all([
    prisma.asset.groupBy({
      by: ["status"],
      where: { projectId, deletedAt: null },
      _count: { _all: true },
      _sum: { sizeBytes: true }
    }),
    prisma.asset.groupBy({
      by: ["mediaType"],
      where: { projectId, deletedAt: null },
      _count: { _all: true },
      _sum: { sizeBytes: true }
    }),
    prisma.remoteFetch.count({ where: { projectId } })
  ]);

  const assets = await prisma.asset.findMany({
    where: { projectId, deletedAt: null },
    select: {
      sizeBytes: true,
      originalBlobId: true,
      renditions: { where: { status: "ready" }, select: { sizeBytes: true, blobId: true } }
    }
  });

  const blobIds = new Set<number>();
  let originalLogicalBytes = 0;
  let renditionLogicalBytes = 0;
  for (const asset of assets) {
    originalLogicalBytes += asset.sizeBytes;
    if (asset.originalBlobId) blobIds.add(asset.originalBlobId);
    for (const r of asset.renditions) {
      renditionLogicalBytes += r.sizeBytes ?? 0;
      if (r.blobId) blobIds.add(r.blobId);
    }
  }

  const blobs = blobIds.size
    ? await prisma.blobObject.findMany({
        where: { id: { in: [...blobIds] } },
        select: { sizeBytes: true }
      })
    : [];
  const physicalBytes = blobs.reduce((sum, b) => sum + b.sizeBytes, 0);
  const logicalBytes = originalLogicalBytes + renditionLogicalBytes;

  const byStatus: Record<string, { count: number; bytes: number }> = {};
  for (const row of statusGroups) {
    byStatus[row.status] = { count: row._count._all, bytes: row._sum.sizeBytes ?? 0 };
  }
  const byMediaType: Record<string, { count: number; bytes: number }> = {};
  for (const row of typeGroups) {
    byMediaType[row.mediaType] = { count: row._count._all, bytes: row._sum.sizeBytes ?? 0 };
  }

  return {
    totalAssets: assets.length,
    originalLogicalBytes,
    renditionLogicalBytes,
    logicalBytes,
    physicalBytes,
    deduplicatedSavings: Math.max(0, logicalBytes - physicalBytes),
    byStatus,
    byMediaType,
    statusCounts: Object.fromEntries(statusGroups.map((g) => [g.status, g._count._all])),
    remoteFetchCount: fetchCount
  };
}
