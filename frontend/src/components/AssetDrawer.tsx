import { useEffect, useState } from "react";
import { toast } from "react-hot-toast";
import { deleteAsset, getAsset, retryTranscode } from "@/api/media";
import type { Asset } from "@/api/types";
import {
  explainErrorCode,
  formatBytes,
  formatDuration,
  formatTime,
  STATUS_META,
  toneClasses
} from "@/utils/format";
import MediaPlayer from "./MediaPlayer";

interface Props {
  projectId: number;
  assetId: number | null;
  onClose: () => void;
  onChanged: () => void;
  /** 用于过滤旧代际回调 */
  liveEvent?: { assetId?: number; jobGeneration?: number; status?: string; progress?: number } | null;
}

const AssetDrawer = ({ projectId, assetId, onClose, onChanged, liveEvent }: Props) => {
  const [asset, setAsset] = useState<Asset | null>(null);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(false);

  useEffect(() => {
    if (!assetId) {
      setAsset(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    getAsset(projectId, assetId)
      .then((data) => {
        if (!cancelled) setAsset(data);
      })
      .catch(() => {
        if (!cancelled) setAsset(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [assetId, projectId]);

  // 应用属于当前代际的实时事件；旧代际（预览切换/重试前）的迟到回调丢弃
  useEffect(() => {
    if (!asset || !liveEvent || liveEvent.assetId !== asset.id) return;
    if (liveEvent.jobGeneration !== undefined && liveEvent.jobGeneration !== asset.jobGeneration) return;
    if (liveEvent.status) {
      setAsset((prev) =>
        prev
          ? {
              ...prev,
              status: liveEvent.status as Asset["status"],
              progress: liveEvent.progress ?? prev.progress
            }
          : prev
      );
    }
  }, [liveEvent, asset?.id, asset?.jobGeneration]);

  const handleRetry = async (mode: "sync" | "async") => {
    if (!asset) return;
    setActing(true);
    try {
      const updated = await retryTranscode(projectId, asset.id, mode);
      setAsset(updated);
      toast.success(mode === "sync" ? "同步探测完成" : "已重新加入转码队列");
      onChanged();
    } catch {
      /* toast 已由拦截器处理 */
    } finally {
      setActing(false);
    }
  };

  const handleDelete = async () => {
    if (!asset) return;
    if (!window.confirm(`确认删除「${asset.filename}」？正在进行的转码结果将被丢弃，不可恢复。`)) return;
    setActing(true);
    try {
      await deleteAsset(projectId, asset.id);
      toast.success("素材已删除");
      onChanged();
      onClose();
    } finally {
      setActing(false);
    }
  };

  const meta = asset ? STATUS_META[asset.status] : null;

  return (
    <>
      <div
        className={`fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-40 transition-opacity ${
          assetId ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        onClick={onClose}
      />
      <aside
        className={`fixed top-0 right-0 h-full w-full sm:w-[560px] bg-slate-50 z-50 shadow-2xl transition-transform duration-300 flex flex-col ${
          assetId ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 bg-white">
          <h3 className="font-bold text-slate-900 text-sm truncate pr-3">素材详情</h3>
          <button
            type="button"
            onClick={onClose}
            className="h-9 w-9 rounded-full hover:bg-slate-100 text-slate-500 transition"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-auto p-5 space-y-5">
          {loading && (
            <div className="space-y-3">
              <div className="h-56 rounded-2xl bg-slate-200 animate-pulse" />
              <div className="h-5 rounded bg-slate-200 animate-pulse w-2/3" />
            </div>
          )}

          {!loading && !asset && (
            <div className="text-center py-20 text-slate-400 text-sm">素材不存在或已被删除</div>
          )}

          {asset && (
            <>
              <MediaPlayer asset={asset} projectId={projectId} />

              <div className="flex items-center gap-2 flex-wrap">
                {meta && (
                  <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ring-1 ${toneClasses(meta.tone)}`}>
                    {meta.label}
                  </span>
                )}
                <span className="text-xs text-slate-500">{meta?.desc}</span>
              </div>

              {asset.status === "failed" && (
                <div className="rounded-xl bg-rose-50 border border-rose-200 p-4 space-y-3">
                  <p className="text-sm font-semibold text-rose-800">失败原因定位</p>
                  <p className="text-xs text-rose-700">{explainErrorCode(asset.errorCode)}</p>
                  {asset.errorMessage && (
                    <pre className="whitespace-pre-wrap break-words text-[11px] bg-white/80 rounded-lg p-3 text-slate-600 max-h-36 overflow-auto border border-rose-100">
                      {asset.errorMessage}
                    </pre>
                  )}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={acting}
                      onClick={() => handleRetry("async")}
                      className="px-3.5 py-2 rounded-lg text-xs font-semibold bg-rose-600 text-white hover:bg-rose-500 transition disabled:opacity-50"
                    >
                      异步重试转码
                    </button>
                    <button
                      type="button"
                      disabled={acting}
                      onClick={() => handleRetry("sync")}
                      className="px-3.5 py-2 rounded-lg text-xs font-semibold border border-rose-300 text-rose-700 hover:bg-rose-100 transition disabled:opacity-50"
                    >
                      同步探测重试
                    </button>
                  </div>
                </div>
              )}

              <section className="bg-white rounded-2xl border border-slate-100 p-4">
                <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-3">源对象与派生</h4>
                <dl className="grid grid-cols-2 gap-y-2.5 gap-x-4 text-xs">
                  <Field label="文件名" value={asset.filename} wide />
                  <Field label="类型" value={asset.mediaType} />
                  <Field label="大小" value={formatBytes(asset.sizeBytes)} />
                  <Field label="分辨率" value={asset.width ? `${asset.width}×${asset.height}` : "—"} />
                  <Field label="时长" value={formatDuration(asset.durationMs)} />
                  <Field label="音轨" value={asset.hasAudio === null ? "探测中" : asset.hasAudio ? "有" : "缺失"} />
                  <Field label="来源" value={asset.source === "remote" ? "远程抓取" : "本地上传"} />
                  <Field label="上传者" value={asset.uploader?.displayName ?? "—"} />
                  <Field label="创建时间" value={formatTime(asset.createdAt)} />
                  <Field label="作业代际" value={`#${asset.jobGeneration}`} />
                  {asset.sourceUrl && <Field label="远程地址" value={asset.sourceUrl} wide />}
                </dl>
              </section>

              {asset.renditions && asset.renditions.length > 0 && (
                <section className="bg-white rounded-2xl border border-slate-100 p-4">
                  <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-3">派生预览</h4>
                  <div className="space-y-2">
                    {asset.renditions.map((r) => (
                      <div key={r.id} className="flex items-center justify-between text-xs">
                        <span className="font-medium text-slate-700">
                          {r.kind === "cover" ? "封面海报" : "可预览版本"}
                        </span>
                        <div className="flex items-center gap-2 text-slate-500">
                          <span>{formatBytes(r.sizeBytes)}</span>
                          <span
                            className={`px-2 py-0.5 rounded-full font-medium ${
                              r.status === "ready"
                                ? "bg-emerald-50 text-emerald-700"
                                : r.status === "failed"
                                  ? "bg-rose-50 text-rose-700"
                                  : "bg-slate-100 text-slate-500"
                            }`}
                          >
                            {r.status === "ready" ? "就绪" : r.status === "failed" ? "失败" : "处理中"}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              <section className="bg-white rounded-2xl border border-slate-100 p-4">
                <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-3">
                  引用关系（{asset.references?.length ?? 0}）
                </h4>
                {asset.references && asset.references.length > 0 ? (
                  <ul className="space-y-2">
                    {asset.references.map((ref) => (
                      <li key={ref.id} className="flex items-center justify-between text-xs bg-slate-50 rounded-lg px-3 py-2">
                        <div>
                          <p className="font-medium text-slate-800">{ref.label}</p>
                          <p className="text-slate-400 font-mono text-[10px]">
                            {ref.refType} · {ref.refKey}
                          </p>
                        </div>
                        <span className="text-slate-400">{ref.creator?.displayName ?? ""}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-slate-400">暂未被场景/时间轴引用。删除素材后可据此评估影响面。</p>
                )}
              </section>

              <div className="flex gap-2 pt-1">
                {(asset.status === "received" || asset.status === "previewable") && (
                  <button
                    type="button"
                    disabled={acting}
                    onClick={() => handleRetry("async")}
                    className="px-4 py-2.5 rounded-xl text-xs font-semibold border border-slate-200 text-slate-700 hover:bg-slate-100 transition disabled:opacity-50"
                  >
                    重新入队
                  </button>
                )}
                <button
                  type="button"
                  disabled={acting}
                  onClick={handleDelete}
                  className="ml-auto px-4 py-2.5 rounded-xl text-xs font-semibold bg-white border border-rose-200 text-rose-600 hover:bg-rose-50 transition disabled:opacity-50"
                >
                  删除素材
                </button>
              </div>
            </>
          )}
        </div>
      </aside>
    </>
  );
};

const Field = ({ label, value, wide }: { label: string; value: string; wide?: boolean }) => (
  <div className={wide ? "col-span-2" : ""}>
    <dt className="text-slate-400">{label}</dt>
    <dd className="text-slate-800 font-medium mt-0.5 break-all">{value}</dd>
  </div>
);

export default AssetDrawer;
