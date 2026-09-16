---
name: git-worktree-skill
description: Safely rebases the current worktree's branch onto a target branch (default: main), rolling back to the pre-rebase state on merge conflicts, then fast-forwards the target branch onto the rebased branch. Use when asked to rebase the current worktree branch onto main or sync a branch into a target branch.
---

# Git Worktree Skill

## Usage

Run the bundled script from the worktree's root directory:

```bash
bash <skill-dir>/rebase.sh [target-branch]
```

- `target-branch` is optional; defaults to `main`.
- Exit code `0` = success, `1` = failure.

## Output contract

The script prints exactly one key=value line and nothing else (no git chatter), plus a `files:` block listing offending files for `dirty-tree` failures. Exit code: 0 on success, 1 on failure.

- Success: `status=success action=<ff-merge|none> source=<branch> target=<branch> head=<short-sha> conflicts=none worktree=<branch>`
- Failure: `status=failed reason=<reason>` with context keys, where `reason` is one of:
  - `not-in-worktree` (+ `cwd=`)
  - `rebase-in-progress`
  - `detached-head`
  - `target-missing` (+ `target=`)
  - `dirty-tree` (+ `source=`, `target=`, `head=`, and the `files:` block)
  - `conflicts` (+ `source=`, `target=`, `head=`, `rolled_back=<yes|no>`, `backup=<ref>`)
  - `switch-failed` (+ `source=`, `target=`, `head=`, `backup=<ref>`)
  - `ff-merge-failed` (+ `source=`, `target=`, `head=`, `rolled_back=yes`, `backup=<ref>`)

## Behavior

- Refuses to run if the working tree has any pending, staged, or untracked changes; lists them.
- Refuses if HEAD is detached, the target branch does not exist, or a rebase is already in progress.
- On merge conflicts: aborts the rebase and rolls HEAD back to exactly where it was before the attempt.
- Before rebasing, records a backup ref (`refs/backup/pre-rebase-<timestamp>`); kept on failure and referenced in the output, deleted on success.
- On a clean rebase: checks out the target branch and fast-forwards it onto the rebased branch; the worktree is left on the target branch.
- If the current branch already is the target branch, reports success with no changes made.
