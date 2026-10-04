import { useEffect, useRef, useState } from "react";

/**
 * 「预览切换后旧回调到达」防护：
 * 打开一个素材时锁定其身份（id）与版本（updatedAt）。之后异步轮询/转码回调
 * 陆续返回，只有同一身份且更新时间不早于当前已采纳版本的快照才会生效；
 * 陈旧回调一律丢弃，避免旧预览覆盖新选择。切换素材（id 变化）时重新锁定。
 */
export function useStaleSnapshot<T extends { id: string; updatedAt: string }>(incoming: T | null): T | null {
  const [snapshot, setSnapshot] = useState<T | null>(incoming);
  const idRef = useRef<string | null>(incoming?.id ?? null);
  const versionRef = useRef<string | null>(incoming?.updatedAt ?? null);

  useEffect(() => {
    if (!incoming) return;
    // 身份切换：重新锁定
    if (incoming.id !== idRef.current) {
      idRef.current = incoming.id;
      versionRef.current = incoming.updatedAt;
      setSnapshot(incoming);
      return;
    }
    // 同一身份：旧回调（时间更早）直接丢弃
    if (versionRef.current != null && incoming.updatedAt < versionRef.current) {
      return;
    }
    if (incoming.updatedAt !== versionRef.current) {
      versionRef.current = incoming.updatedAt;
    }
    setSnapshot((prev) => (prev && prev.updatedAt === incoming.updatedAt ? prev : incoming));
  }, [incoming]);

  return snapshot;
}
