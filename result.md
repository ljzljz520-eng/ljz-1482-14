# 交付结果

## 交付物
AudioVisual 已从静态/模拟层升级为真实素材服务（docker compose 一键启动：MySQL 8 + 后端 Node/TS + ffmpeg + 前端 nginx + 内网 fixtures）。
- 启动：`docker compose up --build`；前端 http://localhost:3000 ，账号 admin/123456（editor/viewer 验证授权隔离）
- 后端 45 个 vitest 用例全过；MySQL schema `prisma validate` 通过；前后端生产构建通过

## 需求覆盖与实测结论（真实接口+数据库，mock 仅隔离测试）
- 分片上传：对象身份(clientToken 幂等会话)/块范围(逐块 offset+长度)/逐块 SHA256 校验；中断后按已收块范围续传；完成请求重试返回同一素材（唯一约束+幂等），浏览器与 curl 双通道实测。
- 状态机：received 原件已收 → previewable 可预览 → ready 完整可用 / failed；stream/original 未 ready 返回 409，播放器只对 ready 开放正式源，预览/封面为派生。
- 同步/异步探测：同步请求内出终态；异步 worker 队列（重启恢复）+ SSE 进度。
- 音轨缺失：纯音频无音轨判定 audio_track_missing 失败；视频无音轨就绪但显式标记。
- 恶意超大：上传前 declaredSize 上限 413；远程 Content-Length 预检 13ms 拒绝 + 流式守卫。
- 删除竞态：jobGeneration 代际 + 多提交点校验，删除时在途转码结果被丢弃，不复活；删除释放 blob 引用并 GC。
- 预览切换旧回调：前端按 assetId+jobGeneration 过滤；播放器卸载/切换 pause+removeAttr+load 释放资源。
- 远程受限下载器：仅 http/https、主机白名单、localhost/私网/保留IP字面量恒拦、逐跳重定向复检、DNS pin 防重绑定、大小/跳转数限制；file://、127.0.0.1、169.254.169.254、白名单跳内网/元数据等 15/15 用例拦截，正常媒体/合法跳转放行并记录 resolvedIp/redirects。
- 去重与授权：BlobObject 按 sha256 去重+refCount，相同字节跨来源复用；授权与项目归属在 Asset/ProjectMember 独立判定，viewer 跨项目 403（字节复用不带来授权共享）；占用区分逻辑/物理/节省。
- 持久化源对象、派生预览(preview/cover)、引用关系(AssetReference)；失败原因可定位（错误码+精简 ffmpeg 诊断）。

## 关键修复（验收过程中发现并解决）
1. ffprobe 缺失时回退探测硬编码 PATH ffmpeg（ENOENT），改为使用解析出的静态/系统二进制。
2. Express 路由器 `.use(auth)` 跨路径前缀误伤，改为逐条路由显式鉴权；只读流/SSE 支持 ?token，写接口仅 Bearer。
3. blob 落库使用 rename 在容器跨挂载点 EXDEV，增加跨设备 copy+unlink 回退。
4. 失败信息净化：ffmpeg banner 提炼为 “moov atom not found” 等关键行，不向前端泄露长日志。
5. React 18 StrictMode 双挂载误清媒体 src，改为 isConnected 判定的卸载释放，保证播放与资源回收并存。

## 隔离测试
tests/：netGuard(SSRF IP/协议/重定向)、mediaParse(音轨/分辨率/时长 banner 解析)、downloader(本机 HTTP fixture：正常/合法重定向/跳内网/超限)、size guard、上传契约与块边界。
