import { FormEvent, useState } from "react";
import { useAuthStore } from "@/store/authStore";
import { toast } from "react-hot-toast";
import { extractApiError } from "@/api/client";

const DEMO_ACCOUNTS = [
  { username: "admin", password: "123456", label: "管理员 admin", role: "两项目 owner" },
  { username: "editor", password: "123456", label: "内容编辑 editor", role: "光影秀/白噪音 editor" },
  { username: "viewer", password: "123456", label: "访客 viewer", role: "仅光影秀 viewer" }
];

const LoginGate = () => {
  const login = useAuthStore((s) => s.login);
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("123456");
  const [loading, setLoading] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    try {
      await login(username.trim(), password);
      toast.success("登录成功");
    } catch (err) {
      toast.error(extractApiError(err).message ?? "登录失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-[70vh] flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="bg-white/90 backdrop-blur rounded-3xl shadow-card border border-white/70 p-8">
          <div className="flex items-center gap-3 mb-6">
            <span className="h-12 w-12 rounded-2xl bg-gradient-to-br from-primary to-accent flex items-center justify-center text-white text-xl">
              视
            </span>
            <div>
              <h2 className="text-xl font-bold text-slate-900">视听素材工作台</h2>
              <p className="text-sm text-slate-500">登录后管理音视频与图片素材</p>
            </div>
          </div>
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">用户名</label>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition"
                placeholder="admin"
                autoComplete="username"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">密码</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition"
                placeholder="••••••"
                autoComplete="current-password"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 rounded-xl bg-gradient-to-r from-primary to-accent text-white font-semibold text-sm shadow-card hover:opacity-90 active:scale-[0.99] transition disabled:opacity-60"
            >
              {loading ? "登录中…" : "登 录"}
            </button>
          </form>
        </div>

        <div className="mt-5 bg-white/70 rounded-2xl border border-white/60 p-5">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">演示账号（点击填充）</p>
          <div className="space-y-2">
            {DEMO_ACCOUNTS.map((acc) => (
              <button
                key={acc.username}
                type="button"
                onClick={() => {
                  setUsername(acc.username);
                  setPassword(acc.password);
                }}
                className="w-full flex items-center justify-between text-left px-3.5 py-2.5 rounded-xl border border-slate-100 hover:border-primary/40 hover:bg-primary/5 transition group"
              >
                <span className="text-sm font-medium text-slate-700 group-hover:text-primary">{acc.label}</span>
                <span className="text-xs text-slate-400">{acc.role}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default LoginGate;
