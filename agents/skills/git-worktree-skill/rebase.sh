#!/usr/bin/env bash
# Safely rebases the current worktree's branch onto a target branch (default: main),
# then fast-forwards the target branch onto the rebased branch.
#
# Usage: rebase.sh [target-branch]
#
# Output: a single key=value line (plus a 'files:' listing for dirty-tree failures).
# Exit code: 0 on success, 1 on failure.
set -u

TARGET="${1:-main}"

short_sha() {
  git rev-parse --short=12 "$1"
}

fail() {
  echo "$1"
  exit 1
}

git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || fail "status=failed reason=not-in-worktree cwd=$(pwd)"

gitdir="$(git rev-parse --git-dir)"
if [ -d "$gitdir/rebase-merge" ] || [ -d "$gitdir/rebase-apply" ]; then
  fail "status=failed reason=rebase-in-progress"
fi

SOURCE="$(git branch --show-current)"
[ -n "$SOURCE" ] || fail "status=failed reason=detached-head"

git rev-parse --verify --quiet "refs/heads/$TARGET" >/dev/null \
  || fail "status=failed reason=target-missing target=$TARGET"

dirty="$(git status --porcelain)"
if [ -n "$dirty" ]; then
  echo "status=failed reason=dirty-tree source=$SOURCE target=$TARGET head=$(short_sha HEAD)"
  echo "files:"
  printf '%s\n' "$dirty"
  exit 1
fi

if [ "$SOURCE" = "$TARGET" ]; then
  echo "status=success action=none source=$SOURCE target=$TARGET head=$(short_sha HEAD) conflicts=none worktree=$TARGET"
  exit 0
fi

ORIGINAL="$(git rev-parse HEAD)"
BACKUP_REF="refs/backup/pre-rebase-$(date +%s)"
git update-ref "$BACKUP_REF" "$ORIGINAL" >/dev/null 2>&1

if ! git rebase "$TARGET" >/dev/null 2>&1; then
  git rebase --abort >/dev/null 2>&1 || git reset --hard "$ORIGINAL" >/dev/null 2>&1
  restored="$(git rev-parse HEAD)"
  if [ "$restored" = "$ORIGINAL" ]; then
    fail "status=failed reason=conflicts source=$SOURCE target=$TARGET head=$(short_sha HEAD) rolled_back=yes backup=$BACKUP_REF"
  fi
  fail "status=failed reason=conflicts source=$SOURCE target=$TARGET head=$(short_sha HEAD) rolled_back=no backup=$BACKUP_REF"
fi

TARGET_WT=""
last_wt=""
while IFS= read -r line; do
  case "$line" in
    "worktree "*) last_wt="${line#worktree }" ;;
    "branch refs/heads/$TARGET")
      TARGET_WT="$last_wt"
      break
      ;;
  esac
done < <(git worktree list --porcelain)

TARGET_BEFORE="$(git rev-parse "refs/heads/$TARGET")"
if [ -n "$TARGET_WT" ]; then
  if ! git -C "$TARGET_WT" merge --ff-only "$SOURCE" >/dev/null 2>&1; then
    if [ "$(git rev-parse "refs/heads/$TARGET")" != "$TARGET_BEFORE" ]; then
      git -C "$TARGET_WT" reset --hard "$TARGET_BEFORE" >/dev/null 2>&1
      rolled="yes"
    else
      rolled="no"
    fi
    fail "status=failed reason=ff-merge-failed source=$SOURCE target=$TARGET head=$(short_sha HEAD) rolled_back=$rolled backup=$BACKUP_REF"
  fi
else
  git switch -q "$TARGET" >/dev/null 2>&1 \
    || fail "status=failed reason=switch-failed source=$SOURCE target=$TARGET head=$(short_sha "$SOURCE") backup=$BACKUP_REF"
  if ! git merge --ff-only "$SOURCE" >/dev/null 2>&1; then
    git reset --hard "$TARGET_BEFORE" >/dev/null 2>&1
    fail "status=failed reason=ff-merge-failed source=$SOURCE target=$TARGET head=$(short_sha HEAD) rolled_back=yes backup=$BACKUP_REF"
  fi
fi

git update-ref -d "$BACKUP_REF" >/dev/null 2>&1
MERGED="$(short_sha "refs/heads/$TARGET")"
FINAL_WT="$(git branch --show-current)"
echo "status=success action=ff-merge source=$SOURCE target=$TARGET head=$MERGED conflicts=none worktree=$FINAL_WT"
