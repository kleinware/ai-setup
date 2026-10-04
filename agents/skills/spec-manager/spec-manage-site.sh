#!/usr/bin/env bash
# Launches the spec viewer/editor site for the project root in the current
# directory. The root must contain a spec/ folder. The Next.js dev server
# (run with bun) binds to 0.0.0.0 on port 8080 by default; pass
# --port <X> (or --port=<X>) to start it on a different port, e.g.
#   spec-manage-site.sh --port 3003
#
# Crash diagnostics: all server output is tee'd to
#   $SPEC_SITE_LOGS/site-<timestamp>.log
# (default: $HOME/spec-manager-site-logs), and when the server exits a crash
# report (exit code, signal, OOM counter, tail of the log) is written to
#   $SPEC_SITE_LOGS/report-<timestamp>.log
# EXPERIMENTAL_DEBUG_MEMORY_USAGE=1 makes the dev server print a memory
# report (RSS/heap) with every request and dump a heap snapshot into
# site/.next/ if heap usage exceeds 70%.
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
export EXPERIMENTAL_DEBUG_MEMORY_USAGE=1

LOG_DIR="${SPEC_SITE_LOGS:-$HOME/spec-manager-site-logs}"
mkdir -p "$LOG_DIR"
RUN_ID="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="$LOG_DIR/site-$RUN_ID.log"
REPORT_FILE="$LOG_DIR/report-$RUN_ID.log"
START_EPOCH="$(date +%s)"

TIP="Tip: pass --port <X> to start the site on a different port (e.g. spec-manage-site.sh --port 3003)"

write_report() {
  local code="$1"
  local oom
  oom="$(sed -n 's/^oom_kill //p' /sys/fs/cgroup/memory.events 2>/dev/null || echo unknown)"
  {
    echo "=== spec-site crash report ==="
    echo "run: $RUN_ID"
    echo "started: $(date -d "@$START_EPOCH" -Is)"
    echo "ended: $(date -Is)"
    echo "uptime: $(( $(date +%s) - START_EPOCH ))s"
    echo "exit code: $code"
    if [ "$code" -ge 128 ]; then
      echo "killed by signal $((code - 128))"
    fi
    echo "cgroup oom_kill: $oom"
    echo "log: $LOG_FILE"
    echo "---- last 80 log lines ----"
    tail -n 80 "$LOG_FILE"
  } > "$REPORT_FILE"
  echo "Server exited with code $code"
  echo "Crash report: $REPORT_FILE"
  echo "Server log: $LOG_FILE"
  echo "$TIP"
}

bun "$site_dir/node_modules/.bin/next" dev -H 0.0.0.0 --port "$PORT" "$site_dir" > >(tee "$LOG_FILE") 2>&1 &
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
  exit_code=$?
  write_report "$exit_code"
  exit "$exit_code"
fi

wait "$server_pid"
exit_code=$?
write_report "$exit_code"
echo "spec-manage-site.sh: error: the site server failed to start on http://127.0.0.1:${PORT}/ — the port may already be in use" >&2
echo "$TIP" >&2
exit 1
