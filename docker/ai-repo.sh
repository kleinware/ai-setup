#!/usr/bin/env bash
set -euo pipefail

usage() {
    echo "Usage: ai-repo <project-name> <ssh-port>" >&2
    exit 1
}

[[ $# -eq 2 ]] || usage

PROJECT="$1"
SSH_PORT="$2"

# Validate the Compose project name.
if [[ ! "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
    echo "Invalid project name: $PROJECT" >&2
    exit 1
fi

# Validate the host SSH port.
if [[ ! "$SSH_PORT" =~ ^[0-9]+$ ]] ||
   (( 10#$SSH_PORT < 1024 || 10#$SSH_PORT > 65535 )); then
    echo "SSH port must be between 1024 and 65535" >&2
    exit 1
fi

# Resolve paths relative to the script, not the current directory.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

export SSH_PORT
export SSH_PUBLIC_KEY="${SSH_PUBLIC_KEY:-$HOME/.ssh/herdr-container.pub}"

if [[ ! -f "$SSH_PUBLIC_KEY" ]]; then
    echo "SSH public key not found: $SSH_PUBLIC_KEY" >&2
    exit 1
fi

docker compose \
    -p "ai-${PROJECT}" \
    up -d --build

SSH_HOST="ai-${PROJECT}"

echo
echo "Project '$PROJECT' is running."
echo
echo "Add the following to ~/.ssh/config:"
echo
cat <<EOF
Host ${SSH_HOST}
    HostName 127.0.0.1
    Port ${SSH_PORT}
    User agent
    IdentityFile ${SSH_PUBLIC_KEY%.pub}
    IdentitiesOnly yes
EOF

echo
echo "Add the container to herdr (nested herdr sessions are not allowed):"
echo "  herdr machine add ${SSH_HOST} --label \"${PROJECT}\""