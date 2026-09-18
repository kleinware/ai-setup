---
name: spec-manager
description: Creates, updates, reads, searches, and validates spec entries stored as YAML in spec/SPECS.md, with status and taxonomy driven by spec/.config.yaml. Use when asked to create a new spec, update an existing spec, read a spec by its ID, find specs that match a keyword, or validate the spec store and config.
---

# Spec Manager Skill

Canonical specs live in one YAML file at the repo root: `spec/SPECS.md`. Repo preferences for the skill live in `spec/.config.yaml`, validated against the JSON Schema in this skill's `.config.schema.json`.

```yaml
specs:
  - id: interface_tui_results_presented-info
    description: One-line statement of the expected behavior.
    motivation: Why this behavior matters.
    acceptance_criteria:
      - Observable condition that means the spec is met.
    status: done
```

`status` appears only when the repo has status enabled (below). Entries are kept sorted alphabetically by `id`, which keeps specs in the same taxonomy branch grouped together and makes IDs easy to find by eye. `write` enforces this; a single write re-sorts an existing unsorted file.

## Config: spec/.config.yaml

```yaml
status:
  - pending
  - done
taxonomy:
  layers: [area, component, section]
  structure:
    isolation:
      container: [access, persistence, setup]
      script: [output, setup]
```

- `status` — one of:
  - `false` — no status is used. A spec that is in source control is valid and approved, and work management happens outside the repo.
  - a non-empty list of state strings — every spec must carry `status` set to one of them.
  - a non-empty list of `{state, description?}` objects — same, with an optional free-text description per state.
  - Missing key or missing file — no status (default).
  - State strings match `^[a-z0-9_]+$` and are unique.
- `taxonomy` — optional:
  - `layers` — non-empty list of unique layer names matching `^[a-z0-9_]+$` (default `area`, `component`, `section` when the key is absent).
  - `structure` — a nested mapping as deep as `layers` minus one: each level maps term names to the next level, and the final level is a list of term names. Term names match `^[a-z0-9]+(?:-[a-z0-9]+)*$`.
  - Missing key — no taxonomy; the membership check is skipped (`taxonomy=skipped`).

Every action validates the config first; a broken config fails with `config-invalid` before anything else runs.

## Schema

Every spec has exactly four fields, plus `status` when status is enabled; nothing else is accepted:

- `id` — stable unique identifier (format below)
- `description` — non-empty string
- `motivation` — non-empty string (why do we want this?)
- `acceptance_criteria` — non-empty string, or a non-empty list of strings (when is this met? observable conditions)
- `status` — required when status is enabled, one of the configured states; forbidden when disabled

## ID format

`{layer1}_{layer2}_..._{layerN}_{result}`, where the layer names come from `taxonomy.layers` (default `area_component_section`), lowercase, with `-` in place of spaces.
Example: `interface_tui_results_presented-info` (area `interface`, component `tui`, section `results`, result `presented-info`).
The agent composes the ID from the project's declared taxonomy in `spec/.config.yaml`.

## Actions

Run from anywhere in the repo; the script resolves the repo root itself. Any action may also take `--spec-dir <dir>` (in any position) to point at a different directory holding `SPECS.md` and `.config.yaml` — default is `<repo-root>/spec`.

```bash
bash <skill-dir>/spec.sh read --id <id>
bash <skill-dir>/spec.sh write --id <id> --description "<text>" --motivation "<text>" --acceptance-criteria "<criterion>" ["<criterion> ...] [--status <state>]
bash <skill-dir>/spec.sh find --query <keyword>
bash <skill-dir>/spec.sh validate
```

- `read` — prints the full spec YAML for `--id`.
- `write` — creates or updates a spec. All fields are taken directly as CLI arguments, so no temporary files are needed. The script validates the config, the schema (including `--status` when enabled), and the taxonomy before writing, keeps the file sorted by id, and writes atomically. Reports `action=create` or `action=update`.
- `find` — case-insensitive substring match across id, description, motivation, acceptance criteria, and status (when enabled); prints the matches as a YAML list of `id`/`description` mappings.
- `validate` — checks the config, that all spec IDs are unique, that every spec matches the schema, that status values are configured states, that IDs match the declared taxonomy, and that every declared taxonomy term has at least one spec. Use it as a gate before committing spec or config changes.

## Output contract

The first stdout line is always a single key=value status line; exit 0 = success, 1 = failure, 2 = usage error.

- Success: `status=success action=<read|create|update|find|validate> ...`
  - `read`: the spec YAML follows after a blank line.
  - `find`: a YAML list of `id`/`description` mappings follows after a blank line.
  - `validate`: `specs=<n> has-status=<true|false> taxonomy=<checked|skipped>`.
- Failure: `status=failed reason=<reason>` plus context keys and, where relevant, a `problems:` block. Reasons:
  - `invalid-id` — id does not match `{layer1_..._layerN}_result`
  - `yaml-error` — the store or config is not valid YAML
  - `config-invalid` — `spec/.config.yaml` violates the skill's `.config.schema.json`
  - `schema-invalid` — an empty or invalid `--description`, `--motivation`, or `--acceptance-criteria` (write), or a spec field violation (validate)
  - `status-invalid` — `--status` missing, unknown, or passed while status is disabled
  - `taxonomy-unknown` — a layer term is not declared in the config taxonomy structure
  - `validate-failed` — duplicate IDs, schema/status/taxonomy violations, or declared taxonomy terms with no specs
  - `not-found` — read of an unknown id (`known=` lists existing ids)
  - `spec-file-missing` — `spec/SPECS.md` does not exist
  - `malformed-store` — `spec/SPECS.md` is not a `specs:` list of mappings
  - `io-error` — file read/write failure

## First-run setup (when spec/.config.yaml is missing)

1. Ask the user their status preference: no status, or which states they want.
2. Write `spec/.config.yaml` with the chosen `status` and the repo's taxonomy (migrate it from the existing `## Spec taxonomy` section in `AGENTS.md` if present).
3. In `AGENTS.md`, remove the `## Spec taxonomy` section and add exactly this one line:
   `For spec structure and taxonomy, see spec/.config.yaml (managed by the spec-manager skill).`
4. Run `validate` and fix any problems.

## Creating a spec (workflow)

1. Read `spec/.config.yaml` (defaults apply when it is missing).
2. Add any new term to `taxonomy.structure` first (and `layers` if the taxonomy is new).
3. Compose the ID from the layer terms.
4. Run `write` with all fields as CLI arguments, plus `--status` when status is enabled.
5. Verify with `read` and `validate`.

## Testing

The skill ships with a CLI test suite. Each scenario under `tst/fixtures/<name>/` is a self-contained spec dir (`SPECS.md` plus an optional `.config.yaml`); `tst/spec.test.ts` runs the script against a copy of each fixture via `--spec-dir` and asserts on the exit code and output.

```bash
cd <skill-dir>
bun test          # run the happy/sad path suite (tst/spec.test.ts)
bunx tsc --noEmit # type-check spec.ts
```
