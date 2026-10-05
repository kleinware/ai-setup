#!/usr/bin/env bash
# Self-contained entrypoint. Creates and reuses an isolated runtime, then runs
# the verifier with the caller's arguments.
set -euo pipefail

skill_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

python_cmd=""
for candidate in python3 python3.14 python3.13 python3.12 python3.11 python3.10; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; raise SystemExit(not ((3, 10) <= sys.version_info[:2] <= (3, 14)))' 2>/dev/null; then
        python_cmd="$candidate"
        break
    fi
done

if [[ -z "$python_cmd" ]]; then
    echo "pre-push verification setup failed: Python 3.10-3.14 is required" >&2
    exit 2
fi

cache_base="${PRE_PUSH_VERIFICATION_CACHE:-${XDG_CACHE_HOME:-${HOME}/.cache}/pre-push-verification}"
runtime_key="$($python_cmd -c 'import hashlib, pathlib, sys; p=pathlib.Path(sys.argv[1]); data=b"".join((p/n).read_bytes() for n in ("requirements.txt", "run.sh")); print(hashlib.sha256(data).hexdigest()[:16])' "$skill_dir")"
runtime_dir="$cache_base/$runtime_key"

if [[ ! -f "$runtime_dir/.ready" ]]; then
    echo "Preparing isolated pre-push-verification runtime in $runtime_dir ..." >&2
    mkdir -p -- "$cache_base"
    rm -rf -- "$runtime_dir"
    mkdir -p -- "$runtime_dir"
    work_dir="$runtime_dir"
    trap 'rm -rf -- "$runtime_dir"' EXIT

    "$python_cmd" -m venv "$work_dir/venv"
    "$work_dir/venv/bin/python" -m pip install --disable-pip-version-check -r "$skill_dir/requirements.txt"
    VIRTUAL_ENV="$work_dir/venv" "$work_dir/venv/bin/python" -m spacy download en_core_web_sm

    os="$(uname -s)"
    arch="$(uname -m)"
    case "$os/$arch" in
        Linux/x86_64|Linux/amd64)
            asset="linux_x64"
            checksum="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
            ;;
        Linux/aarch64|Linux/arm64)
            asset="linux_arm64"
            checksum="e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080"
            ;;
        Darwin/x86_64|Darwin/amd64)
            asset="darwin_x64"
            checksum="dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709"
            ;;
        Darwin/arm64|Darwin/aarch64)
            asset="darwin_arm64"
            checksum="b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5"
            ;;
        *)
            echo "pre-push verification setup failed: unsupported platform $os/$arch" >&2
            exit 2
            ;;
    esac

    gitleaks_version="8.30.1"
    archive="$work_dir/gitleaks.tar.gz"
    url="https://github.com/gitleaks/gitleaks/releases/download/v${gitleaks_version}/gitleaks_${gitleaks_version}_${asset}.tar.gz"
    "$work_dir/venv/bin/python" -c 'import sys, urllib.request; urllib.request.urlretrieve(sys.argv[1], sys.argv[2])' "$url" "$archive"
    actual_checksum="$($work_dir/venv/bin/python -c 'import hashlib, pathlib, sys; print(hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest())' "$archive")"
    if [[ "$actual_checksum" != "$checksum" ]]; then
        echo "pre-push verification setup failed: Gitleaks checksum mismatch" >&2
        exit 2
    fi
    mkdir -p "$work_dir/bin"
    tar -xzf "$archive" -C "$work_dir/bin" gitleaks
    chmod 755 "$work_dir/bin/gitleaks"
    touch "$work_dir/.ready"
    trap - EXIT
fi

export PATH="$runtime_dir/bin:$runtime_dir/venv/bin:$PATH"
exec "$runtime_dir/venv/bin/python" "$skill_dir/scripts/verify_push.py" "$@"
