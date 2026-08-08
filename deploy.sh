#!/usr/bin/env bash
# Deploy de produção — executado pelo GitHub Actions (push na main) ou à mão.
# Idempotente: atualiza o código, reconstrói e sobe sem mexer nos volumes.
set -euo pipefail

cd /opt/agente_upsell

echo "==> Atualizando código (origin/main)"
git fetch origin main
git reset --hard origin/main

echo "==> Build + up"
docker compose -f docker-compose.prod.yml up -d --build

echo "==> Limpando imagens órfãs"
docker image prune -f >/dev/null

echo "==> Status"
docker compose -f docker-compose.prod.yml ps

echo "==> Healthcheck"
for i in $(seq 1 30); do
  if docker compose -f docker-compose.prod.yml exec -T app wget -qO- http://127.0.0.1:3000/health >/dev/null 2>&1; then
    echo "OK: app saudável"
    exit 0
  fi
  sleep 2
done
echo "ERRO: app não respondeu ao healthcheck em 60s"
docker compose -f docker-compose.prod.yml logs --tail 50 app
exit 1
