#!/usr/bin/env bash
set -euo pipefail

echo "[entrypoint] waiting for database ..."
node - <<'NODE'
const net = require("node:net");
const url = new URL(process.env.DATABASE_URL);
const host = url.hostname;
const port = Number(url.port || 3306);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  for (let i = 0; i < 60; i++) {
    const ok = await new Promise((resolve) => {
      const sock = net.connect(port, host);
      sock.once("connect", () => { sock.end(); resolve(true); });
      sock.once("error", () => { sock.destroy(); resolve(false); });
    });
    if (ok) { console.log(`[entrypoint] database reachable at ${host}:${port}`); return; }
    await sleep(1000);
  }
  console.error("[entrypoint] database not reachable in time");
  process.exit(1);
})();
NODE

echo "[entrypoint] prisma db push"
npx prisma db push

echo "[entrypoint] seed users/projects"
node dist/prisma/seed.js || true

echo "[entrypoint] seed demo media through real pipeline"
node dist/prisma/seed-media.js || true

echo "[entrypoint] start backend"
exec node dist/src/server.js
