#!/usr/bin/env bash
# Launches the spec viewer/editor site for the project root in the current
# directory. The root must contain a spec/ folder. The Next.js dev server
# (run with bun) binds to 127.0.0.1 on port 8080 by default; pass
# --port <X> (or --port=<X>) to start it on a different port, e.g.
#   spec-manage-site.sh --port 3003
set -u

PORT=8080
while [ $# -gt 0 ]; do
  case "$1" in
    --port)
      if [ $# -lt 2 ]; then
        echo "spec-manage-site.sh: error: --port requires a value" >&2
        echo "usage: spec-manage-site.sh [--port <X>]" >&2
        exit 2
      fi
      PORT="$2"
      shift 2
      ;;
    --port=*)
      PORT="${1#--port=}"
      shift
      ;;
    *)
      echo "spec-manage-site.sh: error: unknown argument: $1" >&2
      echo "usage: spec-manage-site.sh [--port <X>]" >&2
      exit 2
      ;;
  esac
done

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "spec-manage-site.sh: error: port must be an integer between 1 and 65535 (got: $PORT)" >&2
  echo "usage: spec-manage-site.sh [--port <X>]" >&2
  exit 2
fi

if [ ! -d "spec" ]; then
  echo "spec-manage-site.sh: error: no spec/ folder in $(pwd); run from a project root containing spec/" >&2
  exit 1
fi

dir="$(cd "$(dirname "$0")" && pwd)"
site_dir="$dir/site"

if ! command -v bun >/dev/null 2>&1; then
  echo "spec-manage-site.sh: bun is required (https://bun.sh)" >&2
  exit 2
fi

if [ ! -d "$site_dir/node_modules" ]; then
  ( cd "$site_dir" && bun install ) || {
    echo "spec-manage-site.sh: dependency install failed in $site_dir" >&2
    exit 2
  }
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "spec-manage-site.sh: curl is required (readiness probe)" >&2
  exit 2
fi

export SPEC_ROOT="$(pwd)"
export SPEC_PORT="$PORT"

TIP="Tip: pass --port <X> to start the site on a different port (e.g. spec-manage-site.sh --port 3003)"

bun "$site_dir/node_modules/.bin/next" dev -H 127.0.0.1 --port "$PORT" "$site_dir" &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null' INT TERM

ready=0
while kill -0 "$server_pid" 2>/dev/null; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:${PORT}/" || true)"
  if [ "$code" = "200" ]; then
    ready=1
    break
  fi
  sleep 1
done

if [ "$ready" -eq 1 ]; then
  echo "http://127.0.0.1:${PORT}/"
  echo "$TIP"
  wait "$server_pid"
  exit $?
fi

wait "$server_pid"
echo "spec-manage-site.sh: error: the site server failed to start on http://127.0.0.1:${PORT}/ — the port may already be in use" >&2
echo "$TIP" >&2
exit 1
