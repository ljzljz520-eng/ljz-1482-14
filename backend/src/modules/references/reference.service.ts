import { prisma } from "../../lib/prisma.js";
import { AppError, ErrorCodes } from "../../lib/errors.js";

export interface CreateReferenceInput {
  projectId: number;
  assetId: number;
  userId: number;
  refType: string;
  refKey: string;
  label: string;
}

/** 登记素材引用关系（场景/时间轴等）。 */
export async function createReference(input: CreateReferenceInput) {
  const asset = await prisma.asset.findFirst({
    where: { id: input.assetId, projectId: input.projectId, deletedAt: null }
  });
  if (!asset) throw new AppError(ErrorCodes.NOT_FOUND, "素材不存在", 404);
  if (!["scene", "timeline", "article"].includes(input.refType)) {
    throw new AppError(ErrorCodes.VALIDATION, "引用类型必须是 scene / timeline / article", 422);
  }
  if (!input.refKey.trim() || !input.label.trim()) {
    throw new AppError(ErrorCodes.VALIDATION, "引用标识与名称不能为空", 422);
  }
  return prisma.assetReference.upsert({
    where: {
      projectId_assetId_refType_refKey: {
        projectId: input.projectId,
        assetId: input.assetId,
        refType: input.refType,
        refKey: input.refKey
      }
    },
    update: { label: input.label },
    create: {
      projectId: input.projectId,
      assetId: input.assetId,
      refType: input.refType,
      refKey: input.refKey,
      label: input.label,
      createdBy: input.userId
    }
  });
}

export async function listReferences(projectId: number, assetId?: number) {
  return prisma.assetReference.findMany({
    where: { projectId, ...(assetId ? { assetId } : {}) },
    orderBy: { createdAt: "desc" },
    include: {
      asset: { select: { id: true, filename: true, status: true, deletedAt: true, mediaType: true } },
      creator: { select: { id: true, displayName: true } }
    }
  });
}

export async function deleteReference(projectId: number, referenceId: number) {
  const ref = await prisma.assetReference.findFirst({ where: { id: referenceId, projectId } });
  if (!ref) throw new AppError(ErrorCodes.NOT_FOUND, "引用关系不存在", 404);
  await prisma.assetReference.delete({ where: { id: referenceId } });
}
