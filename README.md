# 云溪公园简介站点

## 🛠 技术栈
- Frontend: React 18 + TypeScript 5.2 + Vite 5 + Tailwind CSS 3.4 + Zustand + React Router
- Backend: （本项目为前端静态站点，可直接部署，无独立后端）
- Database: （前端展示站点，无数据库依赖）

## 🚀 启动指南 (How to Run)
1. 确保 Docker Desktop 已启动。
2. 在根目录执行：`docker compose up --build`
3. 等待容器启动完成后访问 `http://localhost:3000`

## 🔗 服务地址 (Services)
- Frontend: http://localhost:3000
- Backend Swagger: （无后端）
- Database: （无）

## 🧪 测试账号
- Admin: admin / 123456

---

## 🐳 Docker 镜像源配置 (Docker Registry Configuration)

### 推荐配置（基于实际项目验证）

#### 1. Docker 镜像源
**使用官方 Docker Hub 镜像**（已验证稳定可用）

```yaml
# docker-compose.yml 示例
services:
  frontend:
    build: ./frontend
    image: node:20-alpine
```

#### 2. npm 依赖源
**使用淘宝镜像**（国内访问快）

在 `Dockerfile` 中添加：
```dockerfile
RUN npm config set registry https://registry.npmmirror.com
```

### 常用镜像推荐

| 技术栈 | 推荐镜像 | 说明 |
|--------|---------|------|
| Node.js | `node:20-alpine` | 前端构建 |
| Nginx | `nginx:alpine` | 前端生产环境 |

### 使用建议

1. ✅ **优先使用官方镜像**：稳定可靠，无需配置镜像代理
2. ✅ **使用 Alpine 版本**：镜像体积小，构建速度快
3. ✅ **配置 npm 淘宝源**：加速国内依赖下载
4. ✅ **多阶段构建**：减小最终镜像体积

### 常见问题

**Q: Docker 镜像拉取失败？**  
A: 检查网络连接，确保 Docker Desktop 正常运行

**Q: npm install 很慢？**  
A: 确保已配置淘宝镜像源：`npm config set registry https://registry.npmmirror.com`
