# AGENTS.md

Agent skills and repo tooling for running AI agents in isolated containers. Each top-level area below maps to a commit prefix.

## Conventions

- Commit messages must start with one of the allowed prefixes (enforced by `.githooks/commit-msg`; bypass with `--no-verify`):
  - `agents: ` — agent skills and subagents under `agents/`
  - `project: ` — repo-level tooling and docs (`.githooks/`, `setup.sh`, `AGENTS.md`, `README.md`)
  - `isolation: ` — docker container isolation under `docker/`
  - `models: ` — model serving and benchmarking under `models/`
  - `devtools: ` — developer workflow scripts under `devtools/`
  - This list maps 1:1 with `ALLOWED_PREFIXES` in `.githooks/commit-msg`.
- After cloning, run `./setup.sh` to install git hooks.
- Keep this file's Layout section in sync with the repo.

## Layout

- `agents/skills/<name>/` — one skill per folder: `SKILL.md` (frontmatter + usage) plus bundled scripts. Current skills: `git-worktree-skill` (rebase a worktree branch onto a target branch), `spec-manager` (manage the per-leaf specs in `spec/`).
- `agents/agent-files/` — agent definition markdown files (frontmatter + prompt): `spec-curator.md` (mode `primary`), `spec-orchestrator.md` (mode `primary`), `implementation-orchestrator.md` (mode `all`).
- `~/.agents` is a symlink to `agents/` — edit skills in this repo.
- `spec/` — canonical specs, one YAML file per taxonomy leaf (`<leaf>.spec.yaml`; `specs.spec.yaml` when `taxonomy.layers` is `false`), managed via the `spec-manager` skill.
- `spec/.config.yaml` — spec-manager config (status and taxonomy); for spec structure details, see it.
- `docker/` — isolated agent containers: `dev-repo` (`up` / `ls` / `down`), `docker-compose.yml`, `Dockerfile`, `container_herdr_config.toml`, `container_opencode.json`, plus `README.md` with SSH/herdr setup.
- `models/` — local model serving and benchmarking: `serve.sh` (llama-server + socat bridge for containers), `models.ini` (llama-server presets), `benchmark-context.sh` (llama-cli throughput table), `test_image.png`.
- `devtools/` — developer workflow scripts, run inside herdr panes (e.g. `devtools/new-worktree.sh` splits the pane into opencode + lazygit after creating a worktree).
- `.githooks/` — hook sources; `setup.sh` symlinks them into `.git/hooks/`.
- `setup.sh` — installs hooks from `.githooks/` into `.git/hooks/` (run after cloning).
