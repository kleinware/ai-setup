#!/usr/bin/env bash
# Launches the spec viewer/editor site for the project root in the current
# directory. The root must contain a spec/ folder. The Next.js dev server
# (run with bun) binds to 127.0.0.1 on port 8080.
set -u

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

export SPEC_ROOT="$(pwd)"
export SPEC_PORT="${SPEC_PORT:-8080}"

exec bun "$site_dir/node_modules/.bin/next" dev -H 127.0.0.1 --port "$SPEC_PORT" "$site_dir"
