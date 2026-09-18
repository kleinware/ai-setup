# AI Project

Agent skills and repo tooling.

## Layout

- `agents/skills/` — skills, consumed via `~/.agents` (symlinked to `agents/`)
  - one skill per folder: `agents/skills/<name>/SKILL.md` plus bundled scripts
- `.githooks/` — version-controlled git hook sources
- `setup.sh` — installs hooks from `.githooks/` into `.git/hooks/` (run after cloning)
- `devtools/` — developer workflow scripts (e.g. `new-worktree.sh`: split a herdr pane vertically with opencode on the left, lazygit on the right)

## Commit conventions

Commit messages must start with an allowed prefix, enforced by `.githooks/commit-msg`:

- `agents: ` — changes to agent skills/tooling
- `project: ` — changes to the project itself
- `isolation: ` — docker container isolation under `docker/`
- `models: ` — model serving and benchmarking under `models/`
- `devtools: ` — developer workflow scripts under `devtools/`

`git commit --no-verify` bypasses the check.
