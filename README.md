# 云溪公园 · AudioVisual 素材服务

把原静态展示页「视听体验」从模拟请求层改造成了一个**可真实运行的音视频/图片素材服务**：
Web 端分片上传、查看转码进度与存储占用；后端持久记录**源对象、派生预览和引用关系**；
远程链接由**受限下载器**获取，杜绝 SSRF；同步/异步两种探测转码路径；完整的素材状态机与播放器防护。

## 一键启动（Docker）

```bash
docker compose up --build
```

- 前端：<http://localhost:3000>
- 后端 API：<http://localhost:8080>（健康检查 `/health`）
- MySQL 8：仅内网，数据卷持久化 `park_db_data`
- 素材存储：数据卷持久化 `park_media_data`
- `fixtures`：受限下载器的**内部测试源**（仅 compose 内网，不对宿主机暴露）

首次启动后端会自动 `prisma db push` 建表、`seed` 用户与项目、并通过**真实 ffmpeg 转码流水线**生成演示素材（非空库）。

### 测试账号

| 账号 | 密码 | 角色 |
| --- | --- | --- |
| `admin` | `123456` | 两个项目 owner |
| `editor` | `123456` | 内容编辑 |
| `viewer` | `123456` | 仅「夜间光影秀」viewer（用于验证跨项目授权隔离） |

## 技术栈

- **后端**：Node.js 20 + TypeScript（ESM）+ Express + Prisma + MySQL 8，winston 结构化日志，zod 校验，vitest
- **转码/探测**：ffmpeg + ffprobe（Docker 镜像 apt 安装；无 ffprobe 时自动回退解析 `ffmpeg -i` 输出）
- **前端**：React 18 + TypeScript + Vite + Tailwind + Zustand + axios，SSE 实时进度，原生 `<video>/<audio>/<img>` 播放器
- **部署**：docker compose（db + fixtures + backend + frontend/nginx 全容器化，nginx 反代 `/api` 并支持 SSE/Range）

## 核心能力与设计

### 1. 分片上传（对象身份 / 块范围 / 校验值）
- 浏览器先算整文件 SHA-256，以稳定 `clientToken` **幂等创建会话**；刷新/重试拿到服务端已收块范围，仅传缺失块。
- 每个分片：`PUT /projects/:pid/sessions/:sid/chunks/:index`，按 `offset/长度` 校验**块范围**，`X-Chunk-Sha256` **逐块校验**，错误确定性拒收、网络错误指数退避重试，同块重传幂等。
- 完成时服务端顺序拼接、复核整文件哈希与大小，再登记源对象。
- **完成请求重试绝不创建重复素材**：`uploadSession.id` 与 `asset` 一对一唯一约束兜底并发，重复完成返回同一素材（`alreadyExisted=true`）。

### 2. 素材状态机（播放器绝不把半成品当正式源）
| 状态 | 含义 |
| --- | --- |
| `received` 原件已收 | 源对象已完整落库，正在完整性探测 |
| `previewable` 可预览 | 派生预览已生成，**原件仍在转码校验，不能作为正式源** |
| `ready` 完整可用 | 通过完整性校验，原件与预览均可播放 |
| `failed` 失败 | 持久化可定位的错误码与精简原因（如 `audio_track_missing`、`invalid_media: moov atom not found`） |

- 媒体流接口：`stream/original` 要求 `ready`（否则 409）；`stream/preview`、`stream/cover` 仅返回就绪派生。
- 视频无音轨：可正常就绪但显式标记「无音轨」；把无音轨内容当**音频**上传则判定 `audio_track_missing` 失败。

### 3. 同步 vs 异步探测转码
- **异步**：完成上传立即返回「原件已收」，后台 worker 队列（并发可配，重启自动恢复未完成任务）转码，进度经 **SSE** 实时推送。
- **同步**：请求内直接探测+转码到终态，响应即「完整可用/失败」（适合小文件）。

### 4. 作业代际防护（删除/切换后旧回调丢弃）
- 每个素材维护 `jobGeneration`。删除素材或重试转码时代际 +1；worker 在探测后、派生后、**唯一事务提交点**都校验代际与删除状态，迟到的旧作业结果一律丢弃，不会复活已删除素材或覆盖新状态。
- 删除素材时即使转码恰好在跑，完成提交会被拒绝（验收：删除素材时转码完成、预览切换后旧回调到达）。

### 5. 受限下载器（远程链接不是 SSRF 入口）
- 仅允许 `http/https`；拒绝 `file:/gopher:/ftp:` 与内嵌凭证 URL。
- 主机白名单（`REMOTE_ALLOW_HOSTS`，默认仅内网 `fixtures,fixtures.local`）。
- `localhost/回环别名` 与**私网/保留 IP 字面量恒拦**（回环、10/172.16/192.168、链路本地 169.254、云元数据、CGNAT、IPv6 ULA/组播等）。
- DNS 解析结果 **pin 到连接器**防 DNS 重绑定；**逐跳重定向**重新过完整安全校验（白名单主机开放重定向到内网也会在第二跳被拦），重定向次数上限。
- `Content-Length` 预检 + 流式计数双重大小上限（默认 200MB），超限立即中断、不读完 body。
- 抓取过程（resolved IP、redirects、httpStatus、拒绝 reasonCode）全部落库 `RemoteFetch`。

### 6. 字节去重，但授权/项目归属不共享
- 物理对象按 SHA-256 全局去重（`BlobObject.refCount`），相同内容任意来源/用户只存一份；删除素材按引用计数 GC 物理文件。
- 授权与归属在 `Asset`/`ProjectMember` 上独立判定，**绝不随去重共享**；非项目成员无法读取/上传/抓取/播放该项目素材。
- 占用统计区分「逻辑占用（原件+派生名义值）」与「物理占用（去重后 distinct 字节）」及节省量。

### 7. 引用关系
- `AssetReference` 持久记录素材被场景/时间轴/文章的引用，素材详情可见引用面，便于删除前评估影响。

## 主要 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/auth/login` | 登录获取 JWT |
| GET | `/projects` | 当前用户项目（含角色） |
| POST | `/projects/:pid/sessions` | 幂等创建分片会话 |
| GET | `/projects/:pid/sessions/:sid` | 查询已收/缺失块（断点恢复） |
| PUT | `/projects/:pid/sessions/:sid/chunks/:i` | 上传分片（块范围+SHA256） |
| POST | `/projects/:pid/sessions/:sid/complete` | 幂等完成（`probeMode: sync|async`） |
| GET | `/projects/:pid/assets` | 素材列表/筛选/分页 |
| GET | `/projects/:pid/assets/:id` | 素材详情（源/派生/引用/失败原因） |
| DELETE | `/projects/:pid/assets/:id` | 软删除（释放引用，旧作业作废） |
| POST | `/projects/:pid/assets/:id/retry` | 失败重试（代际+1） |
| GET | `/projects/:pid/assets/:id/stream/{original,preview,cover}` | Range 媒体流（就绪校验） |
| GET | `/projects/:pid/events` | SSE 进度流（支持 `?token=`） |
| POST | `/projects/:pid/remote-fetches` | 受限远程抓取 |
| GET | `/projects/:pid/remote-fetches` | 抓取审计记录 |
| GET | `/projects/:pid/stats` | 占用统计 |
| GET/POST/DELETE | `/projects/:pid/references` | 引用关系 |

> `<video>/EventSource` 无法带自定义头，只读的媒体流与 SSE 支持 `?token=`；所有写接口只接受 `Authorization: Bearer`。

## 验收路径（真实接口与数据库，mock 仅用于隔离测试）

后端 `npm test`（45 个用例）覆盖：SSRF IP/协议/重定向判定、ffmpeg banner 解析（音轨识别）、下载器隔离 HTTP fixture（合法/跳内网/超限）、大小守卫、上传契约与块边界。

端到端已实测通过：多分片上传与中断恢复、完成请求重试幂等、内容去重与跨项目 403、无音轨/损坏文件失败、恶意超大文件 413、SSRF 矩阵 15/15、删除素材时在途转码不复活、SSE 进度与代际过滤、Range 播放、预览/原件就绪门控、播放器资源释放、失败原因定位。

### 本地非 Docker 开发

```bash
# 后端（本地可用 SQLite 做真实验证，生产用 MySQL）
cd backend && npm install
../scripts/local-sqlite-setup.sh   # 生成 .local/schema.sqlite.prisma 并建库
export DATABASE_URL="file:./.local/dev.db" STORAGE_ROOT=./data PORT=8080 \
       REMOTE_ALLOW_HOSTS="fixtures,fixtures.local"
npx tsx prisma/seed.ts
npx tsx src/server.ts

# 前端
cd frontend && npm install && npm run dev   # http://localhost:5173 代理到 :8080
```

## 目录

```
backend/
  prisma/        Prisma schema(MySQL) + 用户/项目/演示素材 seed
  src/lib/         netGuard(SSRF) downloader ffmpeg mediaService storage events logger
  src/modules/     auth projects uploads assets remote stats references park
  tests/           vitest（隔离测试，不碰真实网络/生产数据）
fixtures/          内网受限下载测试源（正常媒体/合法跳转/跳内网/超大文件/内网秘密）
frontend/src/
  api/  lib/       axios 客户端、分片上传引擎（恢复/重试/哈希）
  hooks/           SSE 订阅（按代际过滤）
  components/      上传/抓取面板、统计、素材卡片、详情抽屉、播放器（资源释放+就绪门控）
  pages/AudioVisual.tsx
scripts/           本地 SQLite 验证辅助
```
