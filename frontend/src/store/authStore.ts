import { create } from "zustand";
import { persist } from "zustand/middleware";

const TOKEN_KEY = "av.token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

interface AuthState {
  token: string | null;
  setToken: (t: string) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: localStorage.getItem(TOKEN_KEY),
      setToken: (t) => {
        localStorage.setItem(TOKEN_KEY, t.trim());
        set({ token: t.trim() });
      },
      clear: () => {
        localStorage.removeItem(TOKEN_KEY);
        set({ token: null });
      },
    }),
    { name: "av-auth" }
  )
);

// getToken 必须在 client.ts 之外无循环依赖，直接读 localStorage 即可
