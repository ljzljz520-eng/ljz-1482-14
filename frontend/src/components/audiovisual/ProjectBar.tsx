import { useEffect, useState } from "react";
import { KeyRound, ShieldCheck } from "lucide-react";
import { toast } from "react-hot-toast";
import { useAuthStore } from "@/store/authStore";
import { mediaApi } from "@/api/media";

export default function ProjectBar({ onProject }: { onProject: (name: string | null) => void }) {
  const { token, setToken, clear } = useAuthStore();
  const [draft, setDraft] = useState("");
  const [projectName, setProjectName] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (!token) {
      setProjectName(null);
      onProject(null);
      return;
    }
    setChecking(true);
    mediaApi
      .me()
      .then((me) => {
        setProjectName(me.project.name);
        onProject(me.project.name);
      })
      .catch(() => {
        setProjectName(null);
        onProject(null);
      })
      .finally(() => setChecking(false));
  }, [token, onProject]);

  if (!token) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50/80 p-5 shadow-card">
        <div className="flex items-start gap-3">
          <KeyRound className="h-5 w-5 mt-0.5 text-amber-600 shrink-0" />
          <div className="flex-1">
            <h3 className="font-semibold text-slate-900">输入项目访问令牌</h3>
            <p className="text-sm text-slate-600 mt-1 flex flex-wrap items-center gap-1">
              素材与授权按项目隔离。演示令牌：云溪光影
              <code className="px-1.5 py-0.5 rounded bg-white border border-slate-200 text-xs">av_token_yunxi_demo_001</code>
              林间记录
              <code className="px-1.5 py-0.5 rounded bg-white border border-slate-200 text-xs">av_token_linjian_demo_002</code>
            </p>
            <div className="mt-3 flex flex-col sm:flex-row gap-2">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="粘贴 Bearer Token"
                className="flex-1 px-3 py-2 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
              <button
                onClick={() => {
                  if (!draft.trim()) return toast.error("请输入令牌");
                  setToken(draft);
                  setDraft("");
                }}
                className="px-4 py-2 rounded-xl bg-primary text-white text-sm font-medium hover:bg-primary/90 active:scale-[0.98] transition"
              >
                连接项目
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-card">
      <div className="flex items-center gap-3">
        <span className="h-10 w-10 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center text-white">
          <ShieldCheck className="h-5 w-5" />
        </span>
        <div>
          <p className="text-xs text-slate-500">当前项目{checking ? "（校验中…）" : ""}</p>
          <p className="font-semibold text-slate-900">{projectName ?? "令牌无效"}</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <code className="hidden md:inline text-xs text-slate-500 px-2 py-1 rounded-lg bg-slate-100">
          {token.slice(0, 12)}…{token.slice(-4)}
        </code>
        <button
          onClick={() => clear()}
          className="px-3 py-1.5 rounded-lg text-sm border border-slate-200 hover:border-primary hover:text-primary transition"
        >
          切换项目
        </button>
      </div>
    </div>
  );
}
