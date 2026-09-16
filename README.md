# AI Project

Agent skills and repo tooling.

## Layout

- `agents/skills/` — skills, consumed via `~/.agents` (symlinked to `agents/`)
  - one skill per folder: `agents/skills/<name>/SKILL.md` plus bundled scripts
- `.githooks/` — version-controlled git hook sources
- `setup.sh` — installs hooks from `.githooks/` into `.git/hooks/` (run after cloning)

## Commit conventions

Commit messages must start with an allowed prefix, enforced by `.githooks/commit-msg`:

- `agents: ` — changes to agent skills/tooling
- `project: ` — changes to the project itself

`git commit --no-verify` bypasses the check.
