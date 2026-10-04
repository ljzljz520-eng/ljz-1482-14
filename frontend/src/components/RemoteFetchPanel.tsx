import { FormEvent, useEffect, useState } from "react";
import { toast } from "react-hot-toast";
import { z } from "zod";
import { createFetch, listFetches } from "@/api/media";
import { useAuthStore } from "@/store/authStore";
import { extractApiError } from "@/api/client";
import { formatBytes, formatTime } from "@/utils/format";
import type { RemoteFetch } from "@/api/types";

const urlSchema = z.string().url("请输入合法的 http/https 链接").max(2048);

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  pending: { text: "等待中", cls: "bg-slate-100 text-slate-600" },
  downloading: { text: "下载中", cls: "bg-blue-50 text-blue-700" },
  completed: { text: "已完成", cls: "bg-emerald-50 text-emerald-700" },
  rejected: { text: "已拦截", cls: "bg-rose-50 text-rose-700" },
  failed: { text: "失败", cls: "bg-rose-50 text-rose-700" }
};

const REASON_LABEL: Record<string, string> = {
  scheme_not_allowed: "协议不被允许（仅 http/https）",
  host_not_allowlisted: "主机不在允许名单",
  private_ip_literal: "目标指向内网/保留地址",
  localhost_name_blocked: "禁止 localhost/回环别名",
  private_ip_resolved: "域名解析到内网地址",
  content_length_exceeded: "声明大小超限",
  stream_size_exceeded: "实际大小超限，已中断",
  too_many_redirects: "重定向次数超限",
  transport_error: "连接失败或被安全策略中断",
  bad_http_status: "源站返回错误状态码",
  stream_aborted: "下载中断"
};

const RemoteFetchPanel = ({ onFetched }: { onFetched: () => void }) => {
  const projectId = useAuthStore((s) => s.currentProjectId)!;
  const [url, setUrl] = useState("");
  const [probeMode, setProbeMode] = useState<"sync" | "async">("async");
  const [loading, setLoading] = useState(false);
  const [jobs, setJobs] = useState<RemoteFetch[]>([]);

  const load = async () => {
    try {
      setJobs(await listFetches(projectId));
    } catch {
      /* 静默 */
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = urlSchema.safeParse(url.trim());
    if (!parsed.success) {
      toast.error(parsed.error.issues[0].message);
      return;
    }
    setLoading(true);
    try {
      const asset = await createFetch(projectId, parsed.data, probeMode);
      toast.success(`远程素材已获取：${asset.filename}`);
      setUrl("");
      onFetched();
    } catch (err) {
      const apiError = extractApiError(err);
      const details = apiError.details as { reason?: string } | undefined;
      const reason = details?.reason ? REASON_LABEL[details.reason] ?? details.reason : "";
      toast.error(reason ? `${apiError.message}（${reason}）` : apiError.message ?? "抓取失败");
    } finally {
      setLoading(false);
      void load();
    }
  };

  return (
    <div className="rounded-3xl bg-white/80 border border-white/70 shadow-card p-6">
      <div className="flex items-center gap-2 mb-1">
        <h3 className="text-base font-bold text-slate-900">从远程链接获取</h3>
      </div>
      <p className="text-xs text-slate-500 leading-relaxed mb-4">
        由后端<strong className="text-slate-700">受限下载器</strong>获取：仅允许 http/https 与白名单主机，
        逐跳校验重定向、拦截内网/回环/云元数据地址，并限制大小（200MB）。
        任意 URL <strong className="text-rose-600">不会</strong>成为读取服务器本地资源的入口。
      </p>
      <form onSubmit={submit} className="flex gap-2 flex-wrap">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://允许的主机/media/sample.mp4"
          className="flex-1 min-w-[240px] rounded-xl border border-slate-200 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition"
        />
        <div className="inline-flex rounded-xl bg-slate-100 p-1 text-xs font-medium">
          {(["async", "sync"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setProbeMode(mode)}
              className={`px-3 py-2 rounded-lg transition ${
                probeMode === mode ? "bg-white shadow text-primary" : "text-slate-500"
              }`}
            >
              {mode === "sync" ? "同步" : "异步"}
            </button>
          ))}
        </div>
        <button
          type="submit"
          disabled={loading}
          className="px-5 py-2.5 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-700 active:scale-[0.99] transition disabled:opacity-50"
        >
          {loading ? "获取中…" : "获取"}
        </button>
      </form>

      {jobs.length > 0 && (
        <div className="mt-5 space-y-2 max-h-64 overflow-auto pr-1">
          {jobs.slice(0, 12).map((job) => {
            const meta = STATUS_LABEL[job.status] ?? STATUS_LABEL.failed;
            return (
              <div
                key={job.id}
                className="rounded-xl border border-slate-100 bg-white/70 px-3.5 py-2.5 text-xs"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-slate-600 truncate flex-1" title={job.url}>
                    {job.url}
                  </span>
                  <span className={`px-2 py-0.5 rounded-full font-medium ${meta.cls}`}>{meta.text}</span>
                </div>
                <div className="mt-1 flex items-center gap-3 text-slate-400 flex-wrap">
                  <span>{formatTime(job.createdAt)}</span>
                  {job.redirects > 0 && <span>重定向 {job.redirects} 跳</span>}
                  {job.resolvedIp && <span>解析 IP {job.resolvedIp}</span>}
                  {job.sizeBytes ? <span>{formatBytes(job.sizeBytes)}</span> : null}
                  {job.asset && <span className="text-primary">→ {job.asset.filename}</span>}
                </div>
                {(job.reasonCode || job.errorMessage) && (
                  <p className="mt-1 text-rose-600 break-all">
                    {REASON_LABEL[job.reasonCode ?? ""] ?? job.reasonCode}
                    {job.errorMessage ? `：${job.errorMessage}` : ""}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default RemoteFetchPanel;
