import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * 上传会话入参契约测试：与 upload.routes 的 zod schema 保持一致，
 * 验证恶意/非法输入在进入业务逻辑前被拦截。
 */
const createSchema = z.object({
  clientToken: z.string().min(8).max(128),
  filename: z.string().min(1).max(255),
  declaredSize: z.number().int().positive(),
  chunkSize: z.number().int().min(256 * 1024),
  sha256Expected: z.string().regex(/^[a-f0-9]{64}$/i).nullable().optional(),
  contentType: z.string().max(128).nullable().optional()
});

/** 与服务端一致的分片边界计算 */
function chunkBounds(declaredSize: number, chunkSize: number, index: number) {
  const total = Math.ceil(declaredSize / chunkSize);
  const offset = index * chunkSize;
  const size = index === total - 1 ? declaredSize - offset : chunkSize;
  return { total, offset, size };
}

describe("分片上传契约", () => {
  it("拒绝空/负数大小", () => {
    expect(createSchema.safeParse(base({ declaredSize: 0 })).success).toBe(false);
    expect(createSchema.safeParse(base({ declaredSize: -1 })).success).toBe(false);
  });
  it("拒绝过小的分片（<256KB）", () => {
    expect(createSchema.safeParse(base({ chunkSize: 1024 })).success).toBe(false);
  });
  it("拒绝非法 sha256", () => {
    expect(createSchema.safeParse(base({ sha256Expected: "xyz" })).success).toBe(false);
    expect(createSchema.safeParse(base({ sha256Expected: "g".repeat(64) })).success).toBe(false);
  });
  it("接受合法载荷", () => {
    const r = createSchema.safeParse(base({}));
    expect(r.success).toBe(true);
  });
  it("块范围：最后一块为余数大小，其余为整 chunkSize", () => {
    const { total, size } = chunkBounds(4_590_211, 4 * 1024 * 1024, 0);
    expect(total).toBe(2);
    expect(size).toBe(4 * 1024 * 1024);
    const last = chunkBounds(4_590_211, 4 * 1024 * 1024, 1);
    expect(last.size).toBe(4_590_211 - 4 * 1024 * 1024);
    expect(last.offset).toBe(4 * 1024 * 1024);
  });
  it("精确整除时块大小恒等于 chunkSize", () => {
    const r = chunkBounds(8 * 1024 * 1024, 4 * 1024 * 1024, 1);
    expect(r.size).toBe(4 * 1024 * 1024);
  });
});

function base(over: Record<string, unknown>) {
  return {
    clientToken: "ul_test_1234567890",
    filename: "a.mp4",
    declaredSize: 1_000_000,
    chunkSize: 4 * 1024 * 1024,
    sha256Expected: "a".repeat(64),
    contentType: "video/mp4",
    ...over
  };
}
