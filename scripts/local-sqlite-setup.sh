#!/usr/bin/env bash
# 本地（非 Docker）真实端到端验证：把 schema 复制为 SQLite 版本并 push 到文件库。
# 生产交付仍使用 prisma/schema.prisma (MySQL 8)。
set -euo pipefail
cd "$(dirname "$0")/../backend"

cp prisma/schema.prisma .local/schema.sqlite.prisma
# provider 与 url 替换；去掉 MySQL 专有 @db.Text（SQLite 用普通 String 即可）
sed -i 's/provider = "mysql"/provider = "sqlite"/' .local/schema.sqlite.prisma
sed -i 's#url      = env("DATABASE_URL")#url      = "file:./dev.db"#' .local/schema.sqlite.prisma
sed -i 's/ @db.Text//g' .local/schema.sqlite.prisma

export DATABASE_URL="file:./dev.db"
npx prisma generate --schema=.local/schema.sqlite.prisma
npx prisma db push --schema=.local/schema.sqlite.prisma --skip-generate
