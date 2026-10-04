#!/bin/sh
set -e

echo "[entrypoint] waiting for postgres ${DATABASE_URL} ..."
# 不依赖额外工具，用 node 做 TCP 探活，最多等待 60s
node -e '
const net = require("net");
const u = new URL(process.env.DATABASE_URL);
const deadline = Date.now() + 60000;
function ping() {
  const s = net.connect({ host: u.hostname, port: Number(u.port || 5432) });
  s.on("connect", () => { s.end(); process.exit(0); });
  s.on("error", () => {
    if (Date.now() > deadline) { console.error("db not reachable"); process.exit(1); }
    setTimeout(ping, 1000);
  });
}
ping();
'

echo "[entrypoint] applying prisma migrations ..."
npx prisma migrate deploy

echo "[entrypoint] seeding baseline data (idempotent) ..."
node dist/scripts/seed.js

echo "[entrypoint] starting service ..."
exec node dist/src/server.js
