#!/usr/bin/env bash
# Entry point for the spec-manager skill; forwards to spec.py.
set -u
exec python3 "$(dirname "$0")/spec.py" "$@"
