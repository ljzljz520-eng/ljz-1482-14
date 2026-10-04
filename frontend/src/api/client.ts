import axios, { AxiosError } from "axios";
import { toast } from "react-hot-toast";
import { getToken } from "@/store/authStore";

const api = axios.create({
  // @ts-ignore
  baseURL: import.meta.env.VITE_API_BASE || "/api",
  timeout: 20000,
});

// 项目令牌注入：token 决定项目身份；内容去重不共享授权
api.interceptors.request.use((cfg) => {
  const token = getToken();
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

// 401 不弹全局错误 toast（由项目栏引导输入令牌），其余错误统一提示
api.interceptors.response.use(
  (response) => response,
  (error: AxiosError<{ message?: string; errorCode?: string }>) => {
    const status = error.response?.status;
    const message = error.response?.data?.message ?? "网络请求失败，请稍后重试";
    if (status !== 401) toast.error(message);
    return Promise.reject(error);
  }
);

export default api;
