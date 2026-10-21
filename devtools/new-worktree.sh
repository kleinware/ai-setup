#!/usr/bin/env bash
# Run inside a herdr pane (e.g. right after `herdr worktree create`).
# Layout: left = chosen harness (claude/codex/opencode), top right (70% height) = lazygit,
# bottom right (30% height) = plain shell in the project repo.
# Menu keys: up/down + enter, k/j + enter, or 1-3 to pick immediately.
set -eu

left="${HERDR_PANE_ID:?run this inside a herdr pane (HERDR_PANE_ID is not set)}"
options=(claude codex opencode)

choose() {
  local sel=0 key rest="" i
  tput civis >&2
  trap 'tput cnorm >&2' RETURN
  while :; do
    printf '\rSelect harness (↑/↓ enter, or 1-%d):\033[K\n' "${#options[@]}" >&2
    for i in "${!options[@]}"; do
      if [ "$i" -eq "$sel" ]; then
        printf '\033[7m> %d) %s\033[0m\033[K\n' "$((i + 1))" "${options[$i]}" >&2
      else
        printf '  %d) %s\033[K\n' "$((i + 1))" "${options[$i]}" >&2
      fi
    done
    IFS= read -rsn1 key || exit 1
    case "$key" in
      $'\033')
        rest=""
        read -rsn2 -t 0.05 rest || true
        case "$rest" in
          '[A') sel=$(((sel + ${#options[@]} - 1) % ${#options[@]})) ;;
          '[B') sel=$(((sel + 1) % ${#options[@]})) ;;
        esac ;;
      k) sel=$(((sel + ${#options[@]} - 1) % ${#options[@]})) ;;
      j) sel=$(((sel + 1) % ${#options[@]})) ;;
      '') break ;;
      [1-9])
        if [ "$key" -le "${#options[@]}" ]; then sel=$((key - 1)); break; fi ;;
    esac
    printf '\033[%dA' "$((${#options[@]} + 1))" >&2
  done
  harness="${options[$sel]}"
}

right_top="$(herdr pane split "$left" --direction right --cwd "$PWD" | jq -r '.result.pane.pane_id')"
right_bottom="$(herdr pane split "$right_top" --direction down --ratio 0.7 --cwd "$PWD" | jq -r '.result.pane.pane_id')"
herdr pane run "$right_top" lazygit

clear
choose
exec "$harness"
