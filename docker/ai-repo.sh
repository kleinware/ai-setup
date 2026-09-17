#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat >&2 <<'EOF'
Usage: ai-repo <command> [args]

Commands:
  up <project-name> <ssh-port>  Build and start the project container
  ls                            List running AI project containers
EOF
    exit 1
}

[[ $# -ge 1 ]] || usage
COMMAND="$1"
shift

case "$COMMAND" in
    up)
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
            -f "${SCRIPT_DIR}/docker-compose.yml" \
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
        ;;

    ls)
        containers="$(docker ps --filter status=running --format '{{json .}}')"

        if [[ -n "$containers" ]]; then
            rows="$(jq -sr '
                [ .[]
                  | (.Labels | split(",") |
                      map(select(startswith("com.docker.compose.project=")) | split("=") | .[1]) |
                      first) as $proj
                  | select($proj != null and ($proj | startswith("ai-")))
                  | (if (.Ports | length) > 0
                     then (.Ports | split(",") | .[0] | capture(":(?<p>[0-9]+)->") | .p)
                     else "-"
                     end) as $port
                  | [ $proj, $port, .Status ]
                ] | map(@tsv) | join("\n")' <<<"$containers")"
        else
            rows=""
        fi

        if [[ -z "$rows" ]]; then
            echo "No running AI project containers."
        else
            printf '%-20s %5s  %s\n' "PROJECT" "PORT" "STATUS"
            while IFS=$'\t' read -r proj port status; do
                printf '%-20s %5s  %s\n' "$proj" "$port" "$status"
            done <<<"$rows"
        fi
        ;;

    *)
        echo "Unknown command: $COMMAND" >&2
        usage
        ;;
esac
