#!/usr/bin/env bash
# Compile and install this repo's agents and skills for OpenCode, Claude Code,
# and Codex on the local machine.

set -euo pipefail

usage() {
    echo "usage: agents/install-all.sh [--home PATH]" >&2
}

target_home="${HOME}"
if [[ "${1-}" == "--home" && -n "${2-}" && -z "${3-}" ]]; then
    target_home="$2"
elif [[ -n "${1-}" ]]; then
    usage
    exit 2
fi

if [[ -z "$target_home" || "$target_home" == "/" ]]; then
    echo "refusing unsafe target home: $target_home" >&2
    exit 1
fi

for tool in python3 rsync mktemp sort comm install; do
    command -v "$tool" >/dev/null 2>&1 || {
        echo "required tool not found: $tool" >&2
        exit 1
    }
done

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd -- "$script_dir/.." && pwd -P)"
work_dir="$(mktemp -d)"
trap 'rm -rf -- "$work_dir"' EXIT

assets_dir="$work_dir/assets"
new_manifest="$work_dir/manifest"
state_dir="$target_home/.local/state/ai-setup"
manifest="$state_dir/agent-assets.manifest"

python3 "$repo_root/docker/build-agent-assets.py" \
    "$repo_root/agents" "$assets_dir"

mkdir -p \
    "$target_home/.config/opencode/agents" \
    "$target_home/.config/opencode/skills" \
    "$target_home/.claude/agents" \
    "$target_home/.claude/skills" \
    "$target_home/.codex/agents" \
    "$target_home/.agents/skills"

rsync -a "$assets_dir/opencode/agents/" "$target_home/.config/opencode/agents/"
rsync -a "$assets_dir/claude/agents/" "$target_home/.claude/agents/"
rsync -a "$assets_dir/codex/agents/" "$target_home/.codex/agents/"
rsync -a "$assets_dir/skills/" "$target_home/.config/opencode/skills/"
rsync -a "$assets_dir/skills/" "$target_home/.claude/skills/"
rsync -a "$assets_dir/skills/" "$target_home/.agents/skills/"

{
    find "$assets_dir/opencode/agents" -type f -printf '.config/opencode/agents/%P\n'
    find "$assets_dir/claude/agents" -type f -printf '.claude/agents/%P\n'
    find "$assets_dir/codex/agents" -type f -printf '.codex/agents/%P\n'
    find "$assets_dir/skills" -type f -printf '.config/opencode/skills/%P\n'
    find "$assets_dir/skills" -type f -printf '.claude/skills/%P\n'
    find "$assets_dir/skills" -type f -printf '.agents/skills/%P\n'
} | sort -u > "$new_manifest"

# Remove only obsolete files recorded by an earlier run of this script. Never
# use directory-wide deletion because users may have unrelated local assets.
if [[ -f "$manifest" ]]; then
    while IFS= read -r relative_path; do
        case "$relative_path" in
            .config/opencode/agents/*|.config/opencode/skills/*|.claude/agents/*|.claude/skills/*|.codex/agents/*|.agents/skills/*)
                rm -f -- "$target_home/$relative_path"
                ;;
            *)
                echo "ignoring unsafe path in $manifest: $relative_path" >&2
                ;;
        esac
    done < <(comm -23 <(sort -u "$manifest") "$new_manifest")
fi

mkdir -p "$state_dir"
install -m 600 "$new_manifest" "$manifest"

agent_count="$(find "$assets_dir/opencode/agents" -maxdepth 1 -type f | wc -l)"
skill_count="$(find "$assets_dir/skills" -mindepth 1 -maxdepth 1 -type d | wc -l)"
echo "installed $agent_count agents and $skill_count skills for OpenCode, Claude Code, and Codex"
