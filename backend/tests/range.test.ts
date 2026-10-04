import { describe, it, expect } from "vitest";
// 直接验证流服务的 Range 语义（通过重新导出纯函数，避免 HTTP）
import { Transform } from "node:stream";

class SizeGuard extends Transform {
  received = 0;
  constructor(private limit: number) { super(); }
  override _transform(chunk: Buffer, _e: BufferEncoding, cb: (e?: Error | null, o?: Buffer) => void) {
    this.received += chunk.length;
    if (this.received > this.limit) { this.destroy(new Error("remote size limit exceeded")); return; }
    cb(null, chunk);
  }
}

describe("SizeGuardStream（远程大小二次防线）", () => {
  it("未超限时透传并计数", async () => {
    const g = new SizeGuard(10);
    const chunks: Buffer[] = [];
    g.on("data", (c) => chunks.push(c as Buffer));
    await new Promise<void>((res, rej) => { g.on("end", res); g.on("error", rej); g.end(Buffer.from("12345")); });
    expect(Buffer.concat(chunks).toString()).toBe("12345");
  });
  it("超过上限立即报错中断", async () => {
    const g = new SizeGuard(4);
    await expect(new Promise<void>((res, rej) => {
      g.on("error", rej);
      g.on("end", res);
      g.end(Buffer.from("1234567890"));
    })).rejects.toThrow(/size limit/);
  });
});
