#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat >&2 <<'EOF'
Usage: ai-repo <command> [args]

Commands:
  up <ssh-port>  Build and start the project container
  ls            List running AI project containers

Must be run from the git root of a worktree whose folder is named 'main'.
The project name is the name of the folder containing 'main'.
EOF
    exit 1
}

[[ $# -ge 1 ]] || usage
COMMAND="$1"
shift

case "$COMMAND" in
    up)
        [[ $# -eq 1 ]] || usage

        SSH_PORT="$1"

        # Must be run from the git root, and that folder must be named 'main'.
        CWD="$(pwd -P)"
        if [[ "$(basename -- "$CWD")" != "main" ]]; then
            echo "Must be run from a folder named 'main': $CWD" >&2
            exit 1
        fi
        if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
            echo "Must be run from a git worktree: $CWD" >&2
            exit 1
        fi
        if [[ "$(git rev-parse --show-toplevel)" != "$CWD" ]]; then
            echo "Must be run from the git root, not a subdirectory: $CWD" >&2
            exit 1
        fi

        PROJECT_DIR="$(dirname -- "$CWD")"
        PROJECT="$(basename -- "$PROJECT_DIR")"

        # Validate the Compose project name.
        if [[ ! "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
            echo "Invalid project name: $PROJECT" >&2
            exit 1
        fi

        # Validate the host SSH port; the web port is SSH port + 1,
        # so the SSH port must leave room for it.
        if [[ ! "$SSH_PORT" =~ ^[0-9]+$ ]] ||
           (( 10#$SSH_PORT < 1024 || 10#$SSH_PORT > 65534 )); then
            echo "SSH port must be between 1024 and 65534" >&2
            exit 1
        fi

        WEB_PORT=$((SSH_PORT + 1))

        # Create the worktrees directory next to 'main' if it doesn't exist.
        mkdir -p "${PROJECT_DIR}/worktrees"

        # Resolve paths relative to the script, not the current directory.
        # Follow symlinks so this works when the script is invoked through
        # a symlink (e.g. ~/bin/ai-repo -> docker/ai-repo.sh).
        SCRIPT_SOURCE="${BASH_SOURCE[0]}"
        while [[ -L "$SCRIPT_SOURCE" ]]; do
            SCRIPT_LINK_DIR="$(cd -- "$(dirname -- "$SCRIPT_SOURCE")" && pwd -P)"
            SCRIPT_SOURCE="$(readlink -- "$SCRIPT_SOURCE")"
            if [[ "$SCRIPT_SOURCE" != /* ]]; then
                SCRIPT_SOURCE="$SCRIPT_LINK_DIR/$SCRIPT_SOURCE"
            fi
        done
        SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_SOURCE")" && pwd -P)"

        export SSH_PORT
        export WEB_PORT
        export SSH_PUBLIC_KEY="${SSH_PUBLIC_KEY:-$HOME/.ssh/herdr-container.pub}"
        export GITCONFIG="${GITCONFIG:-$HOME/.gitconfig}"
        export PROJECT_DIR
        export HOST_UID="$(id -u)"
        export HOST_GID="$(id -g)"

        if [[ ! -f "$SSH_PUBLIC_KEY" ]]; then
            echo "SSH public key not found: $SSH_PUBLIC_KEY" >&2
            exit 1
        fi

        if [[ ! -f "$GITCONFIG" ]]; then
            echo "gitconfig not found: $GITCONFIG" >&2
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
        echo "Web servers inside the container (port 8080) are reachable at:"
        echo "  http://127.0.0.1:${WEB_PORT}/"
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
