# AGENTS.md

## Conventions

- Commit messages must start with one of the allowed prefixes (enforced by `.githooks/commit-msg`; bypass with `--no-verify`):
  - `agents: ` — agent skills and subagents under `agents/`
  - `project: ` — repo-level tooling and docs (`.githooks/`, `setup.sh`, `AGENTS.md`, `README.md`)
  - `isolation: ` — docker container isolation under `docker/`
  - This list maps 1:1 with `ALLOWED_PREFIXES` in `.githooks/commit-msg`.
- After cloning, run `./setup.sh` to install git hooks.

## Layout

- `agents/skills/<name>/` — one skill per folder: `SKILL.md` (frontmatter + usage) plus bundled scripts.
- `~/.agents` is a symlink to `agents/` — edit skills in this repo.
- `.githooks/` — hook sources; `setup.sh` symlinks them into `.git/hooks/`.
- `spec/SPECS.md` — canonical specs, one YAML file for all specs (managed via the `spec-manager` skill).

## Spec taxonomy

- areas: isolation, tooling
- components: container, script, spec-manager
- sections: access, output, persistence, setup, specs
