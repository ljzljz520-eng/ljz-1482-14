import { Link, useLocation } from "react-router-dom";
import { ReactNode, useState } from "react";
import { useAuthStore } from "@/store/authStore";
import { useUIStore as useOriginalUiStore } from "@/store/uiStore";
import clsx from "clsx";

const navItems = [
  { path: "/", label: "公园总览" },
  { path: "/audiovisual", label: "视听素材" },
  { path: "/timeline", label: "时间轴" }
];

const Layout = ({ children }: { children: ReactNode }) => {
  const { pathname } = useLocation();
  const { isMenuOpen, toggleMenu } = useMenu();

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-b from-blue-50/40 via-white to-orange-50/30">
      <header className="sticky top-0 z-30 backdrop-blur bg-white/85 border-b border-slate-200">
        <div className="mx-auto max-w-7xl px-4 py-3 flex items-center justify-between gap-3">
          <Link to="/" className="flex items-center gap-2 shrink-0">
            <span className="h-10 w-10 rounded-2xl bg-gradient-to-br from-primary to-accent shadow-card flex items-center justify-center text-white font-bold">
              云溪
            </span>
            <div>
              <p className="text-xs text-slate-500">城市微度假</p>
              <h1 className="text-base font-semibold text-slate-900 leading-tight">云溪公园 · 素材工作台</h1>
            </div>
          </Link>
          <nav className="hidden md:flex items-center gap-2">
            {navItems.map((item) => (
              <Link
                key={item.path}
                to={item.path}
                className={clsx(
                  "px-3 py-2 rounded-full text-sm font-medium transition hover:bg-primary/10",
                  pathname === item.path ? "bg-primary/10 text-primary" : "text-slate-600"
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <ProjectSwitcher />
            <UserMenu />
            <button
              onClick={toggleMenu}
              className="md:hidden inline-flex items-center justify-center h-10 w-10 rounded-full border border-slate-200 hover:border-primary hover:text-primary transition"
              aria-label="切换菜单"
            >
              <span className="block h-0.5 w-5 bg-current relative">
                <span className="block absolute -top-1.5 h-0.5 w-5 bg-current" />
                <span className="block absolute top-1.5 h-0.5 w-5 bg-current" />
              </span>
            </button>
          </div>
        </div>
        {isMenuOpen && (
          <div className="md:hidden border-t border-slate-200 bg-white/95">
            <div className="max-w-6xl mx-auto px-4 py-3 grid grid-cols-2 gap-2">
              {navItems.map((item) => (
                <Link
                  key={item.path}
                  to={item.path}
                  className={clsx(
                    "px-3 py-2 rounded-xl text-sm font-medium transition hover:bg-primary/10",
                    pathname === item.path ? "bg-primary/10 text-primary" : "text-slate-600"
                  )}
                  onClick={toggleMenu}
                >
                  {item.label}
                </Link>
              ))}
            </div>
          </div>
        )}
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t border-slate-200 bg-white/70 backdrop-blur">
        <div className="mx-auto max-w-7xl px-4 py-6 flex flex-col md:flex-row items-center justify-between gap-3">
          <p className="text-sm text-slate-500">© 2026 云溪公园 · 自然与创作共生</p>
          <div className="flex gap-3 text-sm text-slate-500">
            <span>素材服务：分片上传 / 受限抓取 / 转码探测</span>
          </div>
        </div>
      </footer>
    </div>
  );
};

function ProjectSwitcher() {
  const projects = useAuthStore((s) => s.projects);
  const currentProjectId = useAuthStore((s) => s.currentProjectId);
  const setCurrentProject = useAuthStore((s) => s.setCurrentProject);
  const user = useAuthStore((s) => s.user);

  if (!user || projects.length === 0) return null;
  return (
    <select
      value={currentProjectId ?? ""}
      onChange={(e) => setCurrentProject(Number(e.target.value))}
      className="hidden sm:block max-w-[160px] truncate rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-primary/30"
      title="切换项目（授权与项目归属相互隔离）"
    >
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

function UserMenu() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const [open, setOpen] = useState(false);
  if (!user) return null;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className="flex items-center gap-2 rounded-full border border-slate-200 pl-1.5 pr-3 py-1.5 hover:border-primary transition"
      >
        <span className="h-7 w-7 rounded-full bg-gradient-to-br from-primary to-accent text-white text-xs font-bold flex items-center justify-center">
          {user.displayName.slice(0, 1)}
        </span>
        <span className="hidden sm:block text-xs font-medium text-slate-700">{user.displayName}</span>
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-44 rounded-2xl bg-white shadow-lg border border-slate-100 p-2 z-50">
          <p className="px-3 py-2 text-xs text-slate-500">登录为 {user.username}</p>
          <button
            type="button"
            onMouseDown={() => logout()}
            className="w-full text-left px-3 py-2 rounded-xl text-xs font-medium text-rose-600 hover:bg-rose-50 transition"
          >
            退出登录
          </button>
        </div>
      )}
    </div>
  );
}

// 移动端菜单开关继续复用原有 uiStore
function useMenu() {
  const isMenuOpen = useOriginalUiStore((s) => s.isMenuOpen);
  const toggleMenu = useOriginalUiStore((s) => s.toggleMenu);
  return { isMenuOpen, toggleMenu };
}

export default Layout;
