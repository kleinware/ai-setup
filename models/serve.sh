#!/usr/bin/env bash

set -euo pipefail

MODELS_ROOT="/mnt/mine/models/llm"
PRESET_FILE="models.ini"
PORT=8778
BRIDGE_HOST="172.17.0.1"

for arg in "$@"; do
    case "$arg" in
        --mitm)
            PORT=8779
            shift
            ;;
    esac
done

# https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md

port_in_use() {
    (exec 3<>"/dev/tcp/$1/$2") 2>/dev/null
}

if port_in_use "127.0.0.1" "$PORT"; then
    echo "127.0.0.1:${PORT} is already in use" >&2
    exit 1
fi
if port_in_use "$BRIDGE_HOST" "$PORT"; then
    echo "${BRIDGE_HOST}:${PORT} is already in use" >&2
    exit 1
fi

cleanup() {
    kill "${SERVER_PID:-}" "${SOCAT_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM

llama-server \
    --host 127.0.0.1 \
    --port "$PORT" \
    --models-dir "$MODELS_ROOT" \
    --models-preset "$PRESET_FILE" \
    --models-max 1 \
    --models-autoload \
    --no-mmproj-offload \
    --cache-ram 16384 \
    --metrics \
    --no-webui \
    --log-verbosity 4 &
SERVER_PID=$!

# Allows docker containers to connect to llama-server

socat "TCP-LISTEN:${PORT},bind=${BRIDGE_HOST},reuseaddr,fork" "TCP:127.0.0.1:${PORT}" &
SOCAT_PID=$!

wait -n
if kill -0 "$SERVER_PID" 2>/dev/null; then
    wait "$SOCAT_PID"
    exit $?
fi
wait "$SERVER_PID"
