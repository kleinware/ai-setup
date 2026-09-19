#!/usr/bin/env bash

set -euo pipefail

MODELS_ROOT="/mnt/mine/models/llm"
PRESET_FILE="models.ini"
PORT=8778
BRIDGE_HOST="$(docker network inspect -f '{{(index .IPAM.Config 0).Gateway}}' bridge)"

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

GRACE_SECONDS=10

is_running() {
    kill -0 "$1" 2>/dev/null || return 1
    [[ $(ps -o stat= -p "$1" 2>/dev/null | tr -d ' ') != Z ]]
}

cleanup() {
    # SIGTERM: lets llama-server run its graceful shutdown (its handler
    # counts both SIGINT and SIGTERM, and a second one force-exits).
    # -P variants take down children: socat's one-per-connection forks and
    # llama-server's router-mode worker processes.
    kill "${SERVER_PID:-}" 2>/dev/null || true
    pkill -TERM -P "${SERVER_PID:-}" 2>/dev/null || true
    pkill -TERM -P "${SOCAT_PID:-}" 2>/dev/null || true
    kill "${SOCAT_PID:-}" 2>/dev/null || true
    local deadline=$(( SECONDS + GRACE_SECONDS ))
    while is_running "${SERVER_PID}" || is_running "${SOCAT_PID}"; do
        if (( SECONDS >= deadline )); then
            break
        fi
        sleep 0.2
    done
    kill -9 "${SERVER_PID:-}" 2>/dev/null || true
    pkill -9 -P "${SERVER_PID:-}" 2>/dev/null || true
    pkill -9 -P "${SOCAT_PID:-}" 2>/dev/null || true
    kill -9 "${SOCAT_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM

# Children ignore SIGINT so Ctrl+C only reaches this script and its trap is
# the single source of shutdown signals (llama-server force-exits on its
# second signal).
(
    trap '' INT
    exec llama-server \
        --host 127.0.0.1 \
        --port "$PORT" \
        --models-dir "$MODELS_ROOT" \
        --models-preset "$PRESET_FILE" \
        --models-max 1 \
        --models-autoload \
        --no-mmproj-offload \
        --cache-ram 16384 \
        --metrics \
        --no-ui \
        --log-verbosity 4
) &
SERVER_PID=$!

# Allows docker containers to connect to llama-server.
# socat forks one child per connection; pkill -P in cleanup tears those down.

(
    trap '' INT
    exec socat "TCP-LISTEN:${PORT},bind=${BRIDGE_HOST},reuseaddr,fork" "TCP:127.0.0.1:${PORT}"
) &
SOCAT_PID=$!

wait -n
if kill -0 "$SERVER_PID" 2>/dev/null; then
    wait "$SOCAT_PID"
    exit $?
fi
wait "$SERVER_PID"
