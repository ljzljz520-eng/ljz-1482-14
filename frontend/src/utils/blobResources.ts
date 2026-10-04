/**
 * 统一管理播放器拿到的 objectURL：
 * 关闭/切换素材时必须 revoke，防止长时间浏览造成浏览器内存泄漏。
 */
export class BlobUrlKeeper {
  private current: string | null = null;

  replace(blob: Blob): string {
    this.revoke();
    this.current = URL.createObjectURL(blob);
    return this.current;
  }

  revoke() {
    if (this.current) {
      URL.revokeObjectURL(this.current);
      this.current = null;
    }
  }

  get value(): string | null {
    return this.current;
  }
}
