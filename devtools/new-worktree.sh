#!/usr/bin/env bash
# Run inside a herdr pane (e.g. right after `herdr worktree create`).
# Splits the pane vertically: opencode in the left pane, lazygit in the right.
set -eu

left="${HERDR_PANE_ID:?run this inside a herdr pane (HERDR_PANE_ID is not set)}"
right="$(herdr pane split --current --direction right | jq -r '.result.pane.pane_id')"
herdr pane run "$left" opencode
herdr pane run "$right" lazygit
