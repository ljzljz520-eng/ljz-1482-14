import { EventEmitter } from "node:events";
import type { Response } from "express";
import { randomUUID } from "node:crypto";

/**
 * 项目级事件总线：转码进度通过 SSE 推送给该项目的所有在线页面。
 * 回调以 assetId + jobGeneration 标识，前端切换预览后旧代际事件直接丢弃。
 */
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

class ProjectEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(200);
  }

  publish(event: AssetEvent) {
    this.emit(`project:${event.projectId}`, event);
  }

  /** 将一个 HTTP 响应挂到项目事件流上，返回取消订阅函数。 */
  attach(res: Response, projectId: number): () => void {
    const listener = (event: AssetEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const channel = `project:${projectId}`;
    this.on(channel, listener);

    const heartbeat = setInterval(() => {
      res.write(`data: ${JSON.stringify({ type: "ping", projectId } satisfies AssetEvent)}\n\n`);
    }, 25_000);
    res.on("close", () => {
      this.removeListener(channel, listener);
      clearInterval(heartbeat);
    });

    res.write(`data: ${JSON.stringify({ type: "ping", projectId, id: randomUUID() } as unknown as AssetEvent)}\n\n`);
    return () => {
      this.removeListener(channel, listener);
      clearInterval(heartbeat);
    };
  }
}

export const eventBus = new ProjectEventBus();
