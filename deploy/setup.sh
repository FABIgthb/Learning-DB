#!/usr/bin/env bash
# Run INSIDE the container (Debian 12) as root. Idempotent: re-run to update.
set -euo pipefail
export LANG=C.UTF-8 LC_ALL=C.UTF-8
APP_DIR=/opt/learn
ENV_FILE=/etc/learn/env

echo "==> System packages"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg postgresql >/dev/null
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
id learn >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin learn

echo "==> PostgreSQL"
systemctl enable --now postgresql >/dev/null
mkdir -p /etc/learn
if [ ! -f "$ENV_FILE" ]; then
  DB_PASS="$(openssl rand -hex 24)"
  runuser -u postgres -- psql -qc "CREATE ROLE learn LOGIN PASSWORD '$DB_PASS';" 2>/dev/null || runuser -u postgres -- psql -qc "ALTER ROLE learn PASSWORD '$DB_PASS';"
  runuser -u postgres -- psql -qc "CREATE DATABASE learn OWNER learn;" 2>/dev/null || true
  cat > "$ENV_FILE" <<ENV
DATABASE_URL=postgresql://learn:${DB_PASS}@127.0.0.1:5432/learn?schema=public
APP_ORIGIN=https://learn.fabi-pm.xyz
NODE_ENV=production
HOSTNAME=127.0.0.1
PORT=3000
NODE_OPTIONS=--max-old-space-size=1024
ENV
  chmod 600 "$ENV_FILE"
fi
set -a; . "$ENV_FILE"; set +a

echo "==> Build"
cd "$APP_DIR"
git pull --ff-only || true
# NODE_ENV=production is set above; the build still needs devDependencies (tailwind, prisma, tsx)
npm ci --include=dev --no-audit --no-fund
npx prisma db push --skip-generate
npx prisma generate
npm run build
cp -r .next/static .next/standalone/.next/static
[ -d public ] && cp -r public .next/standalone/public || true
npm run db:seed
chown -R learn:learn "$APP_DIR"

echo "==> Service"
cp deploy/learn.service /etc/systemd/system/learn.service
systemctl daemon-reload
systemctl enable --now learn >/dev/null
systemctl restart learn
sleep 3
curl -fsS http://127.0.0.1:3000/api/health && echo
