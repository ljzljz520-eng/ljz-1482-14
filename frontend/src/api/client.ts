import axios, { AxiosError } from "axios";
import { toast } from "react-hot-toast";

export const API_BASE = (import.meta.env.VITE_API_BASE as string) || "/api";

export const api = axios.create({
  baseURL: API_BASE,
  timeout: 20000
});

// 分片上传走二进制且耗时更长，单独实例（无全局 JSON 超时压力）
export const uploadApi = axios.create({ baseURL: API_BASE, timeout: 120_000 });

export function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("park_media_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

for (const instance of [api, uploadApi]) {
  instance.interceptors.request.use((config) => {
    const headers = authHeaders();
    for (const [key, value] of Object.entries(headers)) {
      config.headers.set(key, value);
    }
    return config;
  });
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

api.interceptors.response.use(
  (response) => response,
  (error: AxiosError<{ error?: { code: string; message: string; details?: unknown } }>) => {
    if (error.response?.status === 401) {
      onUnauthorized?.();
    }
    const code = error.response?.data?.error?.code;
    const message = error.response?.data?.error?.message;
    // 调用方可自行处理错误（如分片重试），这里只对非静默场景 toast
    const silent = (error.config as never as { silent?: boolean })?.silent;
    if (!silent && message) {
      toast.error(code ? `[${code}] ${message}` : message);
    }
    return Promise.reject(error);
  }
);

uploadApi.interceptors.response.use(
  (r) => r,
  (error: AxiosError<{ error?: { message: string } }>) => {
    const silent = (error.config as never as { silent?: boolean })?.silent;
    if (!silent) toast.error(error.response?.data?.error?.message ?? "上传请求失败，请重试");
    return Promise.reject(error);
  }
);

export interface ApiErrorBody {
  code?: string;
  message?: string;
  details?: unknown;
}

export function extractApiError(err: unknown): ApiErrorBody {
  const ax = err as AxiosError<{ error?: ApiErrorBody }>;
  return ax.response?.data?.error ?? { message: (err as Error).message ?? "未知错误" };
}

export default api;
