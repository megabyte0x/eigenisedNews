#!/usr/bin/env bash
# Local Docker smoke test for eigenisedNews.
# Cross-builds for linux/amd64 (TEE target), runs the container, hits /healthz, dumps logs, cleans up.
set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE="${IMAGE:-eigenised-news:dev}"
HOST_PORT="${HOST_PORT:-3001}"
NAME="eigenised-news-smoke"

echo "==> building $IMAGE for linux/amd64"
docker buildx build --platform linux/amd64 -t "$IMAGE" --load .

echo "==> verifying architecture"
arch=$(docker image inspect "$IMAGE" --format '{{.Architecture}}')
if [ "$arch" != "amd64" ]; then
  echo "ERROR: image architecture is $arch (expected amd64)"
  exit 1
fi

echo "==> running container"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run --rm -d --platform linux/amd64 -p "$HOST_PORT:3000" \
  -e PORT=3000 \
  -e LLM_PROXY_URL=http://stub \
  -e LLM_PROXY_API_KEY=stub \
  -e AGENT_PRIVATE_KEY=0x0000000000000000000000000000000000000000000000000000000000000001 \
  -e AGENT_ID=0x7e5f4552091a69125d5dfcb7b8c2659029395bdf \
  --name "$NAME" "$IMAGE" >/dev/null

sleep 2

echo "==> health check"
code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$HOST_PORT/healthz")
echo "status: $code"

echo "==> last 10 log lines"
docker logs "$NAME" 2>&1 | tail -10

echo "==> cleanup"
docker rm -f "$NAME" >/dev/null

if [ "$code" != "200" ]; then
  echo "FAIL: expected 200, got $code"
  exit 1
fi
echo "OK"
