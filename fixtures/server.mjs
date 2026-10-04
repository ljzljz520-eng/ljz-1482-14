/**
 * 内网 fixture 服务（仅挂在 compose 内网，不向宿主机暴露）：
 *  - /sample.mp4 /sample.m4a /pic.jpg      正常媒体
 *  - /redirect-ok*                          指向允许主机的合法跳转
 *  - /redirect-internal                    跳到 http://fixtures:9000/secret（白名单内，用于演示逐跳校验）
 *  - /huge.bin                              超大资源（大小上限验收）
 *  - /secret                                模拟内网元数据/内部文件，正常路径绝不暴露给受限下载器
 */
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const pub = join(root, "public");
const PORT = Number(process.env.PORT ?? 9000);
const HOST = process.env.HOST_HEADER ?? "fixtures";

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}`);
  const p = url.pathname;

  if (p === "/health") {
    res.end("fixtures ok");
    return;
  }
  if (p === "/secret") {
    // 模拟内网敏感资源：仅当下载器被绕过（如私网直连/开放重定向）时才可能被读到
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("INTERNAL SECRET: this must never be fetched through the restricted downloader");
    return;
  }
  if (p === "/redirect-ok") {
    res.writeHead(302, { Location: `http://${HOST}:${PORT}/sample.mp4` });
    res.end();
    return;
  }
  if (p === "/redirect-chain-1") {
    res.writeHead(302, { Location: `http://${HOST}:${PORT}/redirect-chain-2` });
    res.end();
    return;
  }
  if (p === "/redirect-chain-2") {
    res.writeHead(302, { Location: `http://${HOST}:${PORT}/pic.jpg` });
    res.end();
    return;
  }
  if (p === "/redirect-to-internal") {
    // 白名单主机上的开放重定向到“本机回环”——下载器必须在第二跳拦截
    res.writeHead(302, { Location: "http://127.0.0.1:9000/secret" });
    res.end();
    return;
  }
  if (p === "/redirect-to-metadata") {
    res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
    res.end();
    return;
  }
  if (p === "/huge.bin") {
    const total = 500 * 1024 * 1024; // 500MB，超过默认 200MB 远程上限
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(total) });
    const chunk = Buffer.alloc(1024 * 1024, 0x58);
    let sent = 0;
    const push = () => {
      while (sent < total) {
        if (!res.write(chunk)) {
          res.once("drain", push);
          return;
        }
        sent += chunk.length;
        if (sent >= total) {
          res.end();
          return;
        }
      }
    };
    push();
    res.on("close", () => {
      sent = total; // 客户端中断即停
    });
    return;
  }
  if (p === "/redirect-loop") {
    res.writeHead(302, { Location: `http://${HOST}:${PORT}/redirect-loop` });
    res.end();
    return;
  }

  const file = join(pub, p.split("/").pop() ?? "");
  if (existsSync(file) && statSync(file).isFile()) {
    const ext = file.split(".").pop();
    const type = ext === "mp4" ? "video/mp4" : ext === "m4a" ? "audio/mp4" : ext === "jpg" ? "image/jpeg" : "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(readFileSync(file));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(JSON.stringify({ msg: "fixtures listening", port: PORT }));
});
