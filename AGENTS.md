# AGENTS.md

## Conventions

- Commit messages must start with one of the allowed prefixes (enforced by `.githooks/commit-msg`; bypass with `--no-verify`):
  - `agents: ` — agent skills and subagents under `agents/`
  - `project: ` — repo-level tooling and docs (`.githooks/`, `setup.sh`, `AGENTS.md`, `README.md`)
  - `isolation: ` — docker container isolation under `docker/`
  - `models: ` — model serving and benchmarking under `models/`
  - `devtools: ` — developer workflow scripts under `devtools/` (e.g. herdr pane setup for new worktrees)
  - This list maps 1:1 with `ALLOWED_PREFIXES` in `.githooks/commit-msg`.
- After cloning, run `./setup.sh` to install git hooks.

## Layout

- `agents/skills/<name>/` — one skill per folder: `SKILL.md` (frontmatter + usage) plus bundled scripts.
- `~/.agents` is a symlink to `agents/` — edit skills in this repo.
- `.githooks/` — hook sources; `setup.sh` symlinks them into `.git/hooks/`.
- `spec/SPECS.md` — canonical specs, one YAML file for all specs (managed via the `spec-manager` skill).
- `devtools/` — developer workflow scripts, run inside herdr panes (e.g. `devtools/new-worktree.sh` splits the pane and launches opencode + lazygit after creating a worktree).

## Spec taxonomy

- isolation
  - container
    - access
    - persistence
    - setup
  - script
    - output
    - setup
- tooling
  - spec-manager
    - specs
