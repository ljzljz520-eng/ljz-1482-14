import { useEffect, useRef } from "react";
import { API_BASE } from "@/api/client";
import type { Asset } from "@/api/types";

export interface AssetEvent {
  type: "asset" | "asset_deleted" | "fetch" | "ping";
  assetId?: number;
  projectId: number;
  jobGeneration?: number;
  status?: string;
  stage?: string;
  progress?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  hasAudio?: boolean | null;
  fetchId?: number;
}

interface Handlers {
  onAsset?: (event: AssetEvent) => void;
  onDeleted?: (assetId: number) => void;
  onFetch?: (event: AssetEvent) => void;
}

/**
 * 订阅项目级 SSE。回调由调用方按 assetId + jobGeneration 自行过滤：
 * 切换预览/删除素材后旧代际事件不应再影响界面。
 */
export function useProjectEvents(projectId: number | null, handlers: Handlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!projectId) return;
    const token = localStorage.getItem("park_media_token");
    if (!token) return;

    const es = new EventSource(
      `${API_BASE}/projects/${projectId}/events?token=${encodeURIComponent(token)}`
    );

    es.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as AssetEvent;
        if (event.type === "asset") handlersRef.current.onAsset?.(event);
        else if (event.type === "asset_deleted" && event.assetId)
          handlersRef.current.onDeleted?.(event.assetId);
        else if (event.type === "fetch") handlersRef.current.onFetch?.(event);
      } catch {
        /* 忽略非 JSON 心跳 */
      }
    };
    es.onerror = () => {
      // EventSource 会自动重连；无需额外处理
    };

    return () => {
      es.close();
    };
  }, [projectId]);
}

export type { Asset };
