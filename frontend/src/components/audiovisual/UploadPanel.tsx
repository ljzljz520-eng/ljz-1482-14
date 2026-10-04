import { useRef, useState } from "react";
import { toast } from "react-hot-toast";
import { UploadCloud, Link2, XCircle, RotateCcw, FileVideo } from "lucide-react";
import { mediaApi, type AssetDTO } from "@/api/media";
import { CLIENT_CHUNK_SIZE, uploadFile } from "@/utils/uploader";
import { formatBytes } from "@/utils/format";

interface ActiveUpload {
  file: File;
  uploadId: string;
  chunkSize: number;
  totalChunks: number;
  percent: number;
  status: "hashing" | "uploading" | "finalizing" | "done" | "error" | "aborted";
  message?: string;
  abort?: AbortController;
  assetId?: string;
}

export default function UploadPanel({ onAssetChanged }: { onAssetChanged: () => void }) {
  const [tab, setTab] = useState<"local" | "remote">("local");
  const [uploads, setUploads] = useState<ActiveUpload[]>([]);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [remoteBusy, setRemoteBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const patch = (uploadId: string, p: Partial<ActiveUpload>) =>
    setUploads((list) => list.map((u) => (u.uploadId === uploadId ? { ...u, ...p } : u)));

  const MAX_UPLOAD = 500 * 1024 * 1024; // 与后端 MAX_UPLOAD_BYTES 对齐
  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      if (file.size > MAX_UPLOAD) {
        toast.error(`「${file.name}」超过 500MB 上传上限，已拦截`);
        continue;
      }
      await startUpload(file);
    }
  };

  const startUpload = async (file: File, resumeUploadId?: string) => {
    const chunkSize = CLIENT_CHUNK_SIZE;
    let uploadId = resumeUploadId;
    let totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));

    const controller = new AbortController();
    const placeholder: ActiveUpload = {
      file,
      uploadId: uploadId ?? `pending-${Date.now()}`,
      chunkSize,
      totalChunks,
      percent: 0,
      status: "hashing",
      abort: controller,
    };
    setUploads((l) => (uploadId ? l.map((u) => (u.uploadId === uploadId ? { ...u, status: "uploading", abort: controller, message: undefined } : u)) : [...l, placeholder]));

    try {
      if (!uploadId) {
        const init = await mediaApi.initUpload({ filename: file.name, totalSize: file.size, chunkSize });
        uploadId = init.uploadId;
        totalChunks = init.totalChunks;
        placeholder.uploadId = uploadId;
        placeholder.totalChunks = totalChunks;
        patch(placeholder.uploadId, { uploadId, totalChunks });
      }

      // 断点恢复：查询服务端已收块范围
      let received = new Set<number>();
      try {
        const state = await mediaApi.getUpload(uploadId);
        received = new Set(state.received.map((r) => r.index));
        if (state.status === "COMPLETED" && state.assetId) {
          toast.success("该文件此前已上传完成");
          patch(uploadId, { status: "done", percent: 100, assetId: state.assetId });
          onAssetChanged();
          return;
        }
        if (state.status === "ABORTED") throw new Error("上传会话已中止，请重新选择文件");
      } catch {
        /* 新会话忽略 */
      }

      patch(uploadId, { status: "uploading", percent: received.size > 0 ? Math.round((received.size / totalChunks) * 100) : 0 });
      const result = await uploadFile(
        file,
        { uploadId, chunkSize, totalChunks },
        received,
        {
          chunkSize,
          signal: controller.signal,
          onProgress: (_done, _total, percent) => patch(uploadId!, { percent, status: "uploading" }),
        }
      );
      patch(uploadId, { status: "finalizing", percent: 100, assetId: result.assetId });
      // 给后端一点时间更新状态（图片同步完成；视频/音频转码由 worker 异步完成，列表轮询体现）
      setTimeout(() => {
        patch(uploadId!, { status: "done" });
        onAssetChanged();
      }, 600);
      toast.success(`「${file.name}」上传成功（${result.probe === "sync" ? "同步探测" : "异步探测"}）`);
    } catch (err) {
      if ((err as Error).message === "已取消上传") {
        patch(uploadId ?? placeholder.uploadId, { status: "aborted", message: "已中断，可点击恢复继续" });
      } else {
        patch(uploadId ?? placeholder.uploadId, { status: "error", message: (err as Error).message });
        toast.error((err as Error).message);
      }
    }
  };

  const cancelUpload = async (u: ActiveUpload) => {
    u.abort?.abort();
    patch(u.uploadId, { status: "aborted", message: "已中断（可恢复）" });
  };

  const handleRemote = async () => {
    if (!remoteUrl.trim()) return toast.error("请输入远程链接");
    setRemoteBusy(true);
    try {
      const result = await mediaApi.remoteImport(remoteUrl.trim());
      toast.success(`已从受限白名单拉取：${result.sha256.slice(0, 10)}…`);
      setRemoteUrl("");
      onAssetChanged();
      pollUntilSettled(result.assetId).finally(onAssetChanged);
    } catch {
      // 拦截器已 toast
    } finally {
      setRemoteBusy(false);
    }
  };

  return (
    <div className="rounded-2xl bg-white/90 border border-slate-100 shadow-card p-5">
      <div className="flex items-center gap-2 mb-4">
        <div className="flex rounded-xl bg-slate-100 p-1">
          <TabButton active={tab === "local"} onClick={() => setTab("local")} icon={<UploadCloud size={15} />}>
            本地上传
          </TabButton>
          <TabButton active={tab === "remote"} onClick={() => setTab("remote")} icon={<Link2 size={15} />}>
            远程链接
          </TabButton>
        </div>
        <p className="text-xs text-slate-400 ml-auto hidden sm:block">分片 4MB · 断点续传 · SHA-256 校验</p>
      </div>

      {tab === "local" ? (
        <div className="space-y-3">
          <button
            onClick={() => inputRef.current?.click()}
            className="w-full rounded-2xl border-2 border-dashed border-slate-200 hover:border-primary bg-slate-50/60 hover:bg-primary/5 transition p-8 text-center group"
          >
            <UploadCloud className="mx-auto h-9 w-9 text-slate-300 group-hover:text-primary transition" />
            <p className="mt-2 font-medium text-slate-700 group-hover:text-primary">点击选择音视频或图片</p>
            <p className="text-xs text-slate-400 mt-1">支持 MP4 / MOV / WebM / MP3 / WAV / PNG / JPG 等，单文件最大 500MB</p>
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept="video/*,audio/*,image/*"
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
          <div className="space-y-2">
            {uploads.map((u) => (
              <div key={u.uploadId} className="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
                <div className="flex items-center gap-3">
                  <FileVideo size={18} className="text-primary shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium text-slate-800 truncate">{u.file.name}</p>
                      <span className="text-xs text-slate-400 shrink-0">{formatBytes(u.file.size)}</span>
                    </div>
                    <div className="mt-1.5 h-1.5 rounded-full bg-slate-200 overflow-hidden">
                      <div
                        className={
                          "h-full rounded-full transition-all " +
                          (u.status === "error"
                            ? "bg-rose-400"
                            : u.status === "aborted"
                            ? "bg-amber-400"
                            : u.status === "done"
                            ? "bg-emerald-400"
                            : "bg-gradient-to-r from-primary to-accent")
                        }
                        style={{ width: `${u.percent}%` }}
                      />
                    </div>
                    <div className="mt-1 flex items-center justify-between text-xs">
                      <span className={u.status === "error" ? "text-rose-500" : u.status === "aborted" ? "text-amber-600" : "text-slate-500"}>
                        {statusText(u)}
                      </span>
                      <span className="text-slate-400">{u.percent}%</span>
                    </div>
                  </div>
                  <div className="flex gap-1">
                    {u.status === "uploading" || u.status === "hashing" || u.status === "finalizing" ? (
                      <button onClick={() => cancelUpload(u)} className="p-1.5 rounded-lg hover:bg-rose-50 text-rose-500" title="中断">
                        <XCircle size={17} />
                      </button>
                    ) : u.status === "aborted" ? (
                      <button onClick={() => startUpload(u.file, u.uploadId.startsWith("pending-") ? undefined : u.uploadId)} className="p-1.5 rounded-lg hover:bg-primary/10 text-primary" title="恢复">
                        <RotateCcw size={17} />
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              value={remoteUrl}
              onChange={(e) => setRemoteUrl(e.target.value)}
              placeholder="https://images.unsplash.com/photo-xxxx（仅限白名单主机）"
              className="flex-1 px-3 py-2 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
            <button
              disabled={remoteBusy}
              onClick={handleRemote}
              className="px-4 py-2 rounded-xl bg-primary text-white text-sm font-medium hover:bg-primary/90 disabled:opacity-60 transition"
            >
              {remoteBusy ? "受限拉取中…" : "拉取并入库"}
            </button>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            服务端下载器仅允许 <code>http/https</code> 与白名单主机，解析后校验公网 IP，拒绝环回/内网/重定向到
            <code>file://</code>，并限制下载大小。任意 URL 不会成为读取服务器本地资源的入口。
          </p>
        </div>
      )}
    </div>
  );
}

function statusText(u: ActiveUpload): string {
  switch (u.status) {
    case "hashing":
      return "正在计算校验值…";
    case "uploading":
      return "分片上传中（中断后可凭对象身份恢复）";
    case "finalizing":
      return "正在校验组装并登记素材…";
    case "done":
      return "上传完成";
    case "error":
      return u.message ?? "上传失败";
    case "aborted":
      return u.message ?? "已中断";
  }
}

function TabButton({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={
        "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition " +
        (active ? "bg-white text-primary shadow-sm" : "text-slate-500 hover:text-slate-700")
      }
    >
      {icon}
      {children}
    </button>
  );
}

async function pollUntilSettled(assetId: string) {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const a: AssetDTO = await mediaApi.get(assetId);
      if (a.status === "READY" || a.status === "FAILED") return a;
    } catch {
      return;
    }
  }
}
