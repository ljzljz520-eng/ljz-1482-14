// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useStaleSnapshot } from "@/hooks/useStaleSnapshot";
import { BlobUrlKeeper } from "@/utils/blobResources";

const asset = (id: string, updatedAt: string, extra: Record<string, unknown> = {}) => ({
  id,
  updatedAt,
  ...extra,
});

describe("预览切换后旧回调到达：旧快照不得覆盖新选择", () => {
  it("同一素材：只接受时间不早于锁定版本的快照", () => {
    const t0 = "2026-10-04T10:00:00.000Z";
    const t1 = "2026-10-04T10:00:05.000Z";
    const t2 = "2026-10-04T10:00:10.000Z";
    const { result, rerender } = renderHook(({ a }) => useStaleSnapshot(a), {
      initialProps: { a: asset("a1", t0, { status: "PREVIEWABLE" }) },
    });
    expect(result.current?.updatedAt).toBe(t0);

    // 更新的回调到达 → 采纳
    rerender({ a: asset("a1", t1, { status: "READY" }) });
    expect((result.current as unknown as { status: string }).status).toBe("READY");

    // 一个更早完成、但迟到的旧回调（例如旧预览源的轮询响应）→ 必须丢弃，READY 不被回退
    rerender({ a: asset("a1", t0, { status: "RECEIVED", staleSeq: 99 }) });
    expect(result.current?.updatedAt).toBe(t1);
    expect((result.current as unknown as { status: string }).status).toBe("READY");

    rerender({ a: asset("a1", t2, { status: "READY" }) });
    expect(result.current?.updatedAt).toBe(t2);
  });

  it("切换到不同素材（id 改变）时以新素材的版本重新锁定", () => {
    const tA = "2026-10-04T10:00:00.000Z";
    const tB = "2026-10-04T09:00:00.000Z"; // B 自身更新时间更早也没关系，身份变了
    const { result, rerender } = renderHook(({ a }) => useStaleSnapshot(a), {
      initialProps: { a: asset("A", tA) },
    });
    expect(result.current?.id).toBe("A");
    rerender({ a: asset("B", tB) });
    expect(result.current?.id).toBe("B");
    expect(result.current?.updatedAt).toBe(tB);
  });
});

describe("播放器资源释放：BlobUrlKeeper", () => {
  beforeEach(() => {
    const created: string[] = [];
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => {
        const u = `blob:mock-${created.length}`;
        created.push(u);
        return u;
      }),
      revokeObjectURL: vi.fn(),
    });
  });

  it("replace 时撤销上一个 URL；destroy 时最终释放", () => {
    const keeper = new BlobUrlKeeper();
    const u1 = keeper.replace(new Blob(["a"]));
    const u2 = keeper.replace(new Blob(["bb"]));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(u1);
    expect(keeper.value).toBe(u2);
    keeper.revoke();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(u2);
    expect(keeper.value).toBeNull();
  });

  it("重复 revoke 幂等，不重复撤销", () => {
    const keeper = new BlobUrlKeeper();
    keeper.replace(new Blob(["x"]));
    keeper.revoke();
    keeper.revoke();
    expect((URL.revokeObjectURL as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
  });
});

void act;
