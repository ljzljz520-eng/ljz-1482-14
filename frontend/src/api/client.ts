import axios from "axios";
import { toast } from "react-hot-toast";

const api = axios.create({
  // @ts-ignore
  baseURL: import.meta.env.VITE_API_BASE || "/api",
  timeout: 10000
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    toast.error(error?.response?.data?.message ?? "网络请求超时，请稍后重试");
    return Promise.reject(error);
  }
);

export default api;
