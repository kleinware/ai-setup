# AGENTS.md

## Conventions

- Commit messages must start with `agents: ` or `project: ` (enforced by `.githooks/commit-msg`; bypass with `--no-verify`).
- After cloning, run `./setup.sh` to install git hooks.

## Layout

- `agents/skills/<name>/` — one skill per folder: `SKILL.md` (frontmatter + usage) plus bundled scripts.
- `~/.agents` is a symlink to `agents/` — edit skills in this repo.
- `.githooks/` — hook sources; `setup.sh` symlinks them into `.git/hooks/`.
