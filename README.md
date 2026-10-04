# 云溪公园 · AudioVisual 素材服务

把「视听体验」从模拟请求层接成了**可真实工作的音视频/图片素材服务**：Web 上传（可分片、断点续传、校验）、远程链接受限拉取、转码探测（同步/异步两条路径共用同一状态机）、素材库与占用统计、源对象/派生预览/引用关系全部持久化在 PostgreSQL。

## 🛠 技术栈
- **Frontend**: React 18 + TypeScript 5 + Vite 5 + Tailwind CSS 3 + Zustand + react-hot-toast + lucide-react
- **Backend**: Node.js 20 + Fastify 4 + Prisma 6（pg 驱动适配层）+ Zod + Pino + ffmpeg/ffprobe（真实转码）
- **Database**: PostgreSQL 16
- **测试**: Vitest；验收路径全部走真实 PG + 真实 ffmpeg（本地用 embedded-postgres 拉起真实 PG 进程），`mock` 仅用于隔离单测（如 objectURL 生命周期）

## 🚀 启动指南 (How to Run)
1. 确保 Docker Desktop / Docker Engine 已启动。
2. 在仓库根目录执行：
   ```bash
   docker compose up --build
   ```
3. 等待数据库迁移与种子数据完成（backend 日志出现 `audiovisual asset service listening`）。
4. 浏览器访问 http://localhost:3000 ，进入「视听体验」页。

仅启动后端（开发）：`cd backend && npm install && npm run dev`（需要可用的 PostgreSQL 与本机 ffmpeg）。

## 🔗 服务地址 (Services)
- Frontend: http://localhost:3000 （Nginx 反代 `/api` 到后端容器）
- Backend API: http://localhost:8000
- Health: http://localhost:8000/health
- Database: localhost:5432（user: `audiovisual` / pass: `audiovisual` / db: `audiovisual`），数据与素材均挂载 Docker Volume

## 🧪 测试账号 / 项目令牌
素材与授权**按项目隔离**，登录方式是在页面顶部粘贴 Bearer Token：
- 云溪光影项目：`av_token_yunxi_demo_001`
- 林间记录项目：`av_token_linjian_demo_002`

两个项目预置了「含音轨视频 / 无音轨视频 / 音频 / 图片 / 跨项目同字节副本 / 一个损坏文件」用于演示全部状态。

---

## 核心设计

### 素材状态机（同步探测与异步探测共用）
```
RECEIVED（原件已收）
   │  ffprobe 探测元数据
   ├─ 视频：先出缩略图 ──▶ PREVIEWABLE（可预览）── 转 H.264/AAC 预览 ──▶ READY（完整可用）
   ├─ 音频：先出波形   ──▶ PREVIEWABLE ── 转 AAC 预览 ──▶ READY
   └─ 图片：缩略图完成即 READY
任意阶段失败 ──▶ FAILED（可查询 errorCode/errorMessage）
```
- 完成上传时先在 `SYNC_PROBE_MS` 预算内**同步探测**：图片在请求内一步到位；音视频立即入队由 worker **异步转码**；同步探测超时不判失败，保持 RECEIVED 并异步接管。`probeMode`/`probeMs` 记录本次走了哪条路径。
- 派生产物：`thumbnail`、`video-preview`(H.264/AAC faststart)、`audio-preview`(AAC)、`waveform`。
- **播放器不得把半成品当正式源**：只有 `PREVIEWABLE/READY` 才返回预览字节，RECEIVED/unknown 请求预览直接 `409/404`。

### 分片上传（对象身份 + 块范围 + 校验值）
- `POST /api/uploads` 得到 `uploadId`（对象身份）；客户端可凭 `GET /api/uploads/:id` 查到「已收块 index/offset/sha256」清单，从中断处续传。
- `PUT /api/uploads/:id/chunks/:index` 原始字节流，按 index 计算期望 offset/大小，`X-Chunk-Sha256` 做块校验；重复 PUT 已存在块幂等。
- `POST /api/uploads/:id/complete` 顺序组装 + 全量 SHA-256，按内容寻址落盘。**完成请求重试靠 `uploadSessionId` 唯一约束幂等，绝不创建重复素材**。
- 声明体积超过 `MAX_UPLOAD_BYTES` 直接 `413`；块实际字节超出范围在流式传输中拦截（防恶意超大文件）。

### 内容去重 vs 授权/项目归属
- 物理字节按 `sha256` 内容寻址，**内容相同只存一份**（含跨项目、含派生预览）。
- 但 `Asset`、`BlobReference`、可访问授权全部**项目隔离**：去重绝不共享归属，A 项目无法看到/下载 B 项目素材（跨项目访问返回 404）。
- 删除素材按引用计数 GC：仅当所有项目都不再引用某 blob 时才回收物理字节。

### 受限远程下载器（防 SSRF / 防本地文件读取）
`POST /api/remote-import`：只允许 `http/https`；主机必须命中白名单（默认仅公网图床域名）；DNS 解析后校验公网 IP，拒绝环回/内网/链路本地；重定向逐跳重复白名单与协议校验（拒绝跳到 `file://`）；限制 `Content-Length` 且流式传输中硬截断超限响应；校验 Content-Type。**任意 URL 不会成为读取服务器本地资源的入口**。

### 删除素材时转码完成
- 删除即取消排队/运行任务、删行；worker 完成时状态更新使用带条件 `updateMany`，影响行数 0 即感知资产已消失，**丢弃转码产物，绝不复活已删素材**；孤儿 blob 随后 GC。

### 预览切换后旧回调到达（陈旧响应）
- 后端：状态只沿状态机前进，不会因陈旧任务从 READY 退回。
- 前端：`useStaleSnapshot` 以 `id + updatedAt` 锁定版本，迟到的旧快照直接丢弃；播放器用 `BlobUrlKeeper` 在关闭/切换时 `revokeObjectURL`，并 `pause()/removeAttribute('src')/load()` 释放解码器。

## 📡 主要接口
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/uploads` | 初始化分片上传（声明大小/块大小/整体 sha） |
| GET | `/api/uploads/:id` | 已收分片清单（断点恢复） |
| PUT | `/api/uploads/:id/chunks/:index` | 上传单块（字节流 + 块 sha） |
| POST | `/api/uploads/:id/complete` | 完成（**幂等**，返回 assetId） |
| DELETE | `/api/uploads/:id` | 中止上传 |
| POST | `/api/remote-import` | 白名单远程链接受限拉取入库 |
| GET | `/api/assets` / `/api/assets/:id` | 列表 / 详情（含 job 进度） |
| DELETE | `/api/assets/:id` | 删除素材（取消任务 + GC） |
| GET | `/api/blobs/source/:assetId` | 下载原件（项目鉴权） |
| GET | `/api/blobs/derivative/:assetId/:kind` | 下载预览/缩略图/波形（状态校验） |
| GET | `/api/stats` | 占用：逻辑体积/去重节省/物理占用/状态计数 |
| GET | `/api/me` | 当前令牌对应项目 |

所有接口需 `Authorization: Bearer <token>`（`/health` 除外）。

## ✅ 验收场景（均有自动化覆盖）
后端 `npm test`（35 个用例，真实 PG + 真实 ffmpeg）：
1. 上传中断后凭 uploadId + 块范围恢复；
2. 音轨缺失（标记 `NO_AUDIO_STREAM`，仍 READY，不影响画面）；
3. 恶意超大文件（声明超限 413 / 块流超限截断）；
4. 删除素材时转码完成（任务 CANCELLED、产物丢弃、不复活、blob GC）；
5. 预览切换后旧回调到达（状态不回退、删除资产后延迟任务不写回）；
6. 完成请求重试不创建重复素材、块校验失败 422；
7. 同字节跨项目去重但授权隔离；
8. `file://`/内网 IP/非白名单主机/重定向到 file/非媒体类型/流式超大响应 全部拦截；
9. 同步 vs 异步探测对比、损坏文件 FAILED 且无半成品；
10. 占用统计（逻辑/去重/物理）。

前端 `npm test`（jsdom 隔离单测）：陈旧快照丢弃、objectURL 释放幂等。
网页内播放器在关闭/切换时释放媒体资源，失败时展示 `errorCode + 可读原因`。

## 📁 目录
```
backend/   Fastify + Prisma + ffmpeg 素材服务（src/services 为存储/上传/下载器/转码/worker）
frontend/  React 素材管理 UI（src/components/audiovisual、src/pages/AudioVisual.tsx）
docker-compose.yml  db(postgres:16) + backend(node:20+ffmpeg) + frontend(nginx)
```
