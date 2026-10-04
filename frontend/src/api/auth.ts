import { api } from "./client";

export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  role: string;
}

export async function login(username: string, password: string) {
  const { data } = await api.post<{ token: string; user: SessionUser }>("/auth/login", {
    username,
    password
  });
  localStorage.setItem("park_media_token", data.token);
  localStorage.setItem("park_media_user", JSON.stringify(data.user));
  return data;
}

export function logout() {
  localStorage.removeItem("park_media_token");
  localStorage.removeItem("park_media_user");
}

export function currentUser(): SessionUser | null {
  try {
    const raw = localStorage.getItem("park_media_user");
    return raw ? (JSON.parse(raw) as SessionUser) : null;
  } catch {
    return null;
  }
}

export function isLoggedIn(): boolean {
  return Boolean(localStorage.getItem("park_media_token"));
}
