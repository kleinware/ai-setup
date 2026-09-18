#!/usr/bin/env bash
# Entry point for the spec-manager skill; forwards to spec.ts via bun.
set -u
dir="$(dirname "$0")"
if ! command -v bun >/dev/null 2>&1; then
  echo "spec.sh: bun is required (https://bun.sh)" >&2
  exit 2
fi
if [ ! -d "$dir/node_modules" ]; then
  ( cd "$dir" && bun install >/dev/null ) || {
    echo "spec.sh: dependency install failed in $dir" >&2
    exit 2
  }
fi
exec bun "$dir/spec.ts" "$@"
