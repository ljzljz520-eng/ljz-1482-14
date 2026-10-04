import { create } from "zustand";
import type { SessionUser } from "@/api/auth";
import { currentUser, login as apiLogin, logout as apiLogout } from "@/api/auth";
import type { Project } from "@/api/types";
import { listProjects } from "@/api/media";

interface AuthState {
  user: SessionUser | null;
  projects: Project[];
  currentProjectId: number | null;
  hydrated: boolean;
  hydrate: () => void;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  loadProjects: () => Promise<void>;
  setCurrentProject: (id: number) => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  projects: [],
  currentProjectId: null,
  hydrated: false,

  hydrate: () => {
    const user = currentUser();
    const savedProject = Number(localStorage.getItem("park_current_project"));
    set({
      user,
      currentProjectId: Number.isFinite(savedProject) && savedProject > 0 ? savedProject : null,
      hydrated: true
    });
    if (user) void get().loadProjects();
  },

  login: async (username, password) => {
    const data = await apiLogin(username, password);
    set({ user: data.user });
    await get().loadProjects();
  },

  logout: () => {
    apiLogout();
    localStorage.removeItem("park_current_project");
    set({ user: null, projects: [], currentProjectId: null });
  },

  loadProjects: async () => {
    const projects = await listProjects();
    const current = get().currentProjectId;
    const validCurrent = projects.find((p) => p.id === current)?.id;
    const nextId = validCurrent ?? projects[0]?.id ?? null;
    if (nextId && nextId !== current) localStorage.setItem("park_current_project", String(nextId));
    set({ projects, currentProjectId: nextId });
  },

  setCurrentProject: (id) => {
    localStorage.setItem("park_current_project", String(id));
    set({ currentProjectId: id });
  }
}));
