---
name: spec-manager
description: Creates, updates, reads, searches, and validates spec entries stored as YAML in per-leaf spec/*.spec.md files, with status and taxonomy driven by spec/.config.yaml. Use when asked to create a new spec, update an existing spec, read a spec by its ID, find specs that match a keyword, or validate the spec store and config.
---

# Spec Manager Skill

Canonical specs live in `spec/`, partitioned into one YAML file per taxonomy leaf: `spec/<layer terms>.spec.md` (for example `spec/interface_tui_results.spec.md`). When `taxonomy.layers` is `false` there is no hierarchy and all specs live in a single `spec/specs.spec.md`. Repo preferences for the skill live in `spec/.config.yaml`, validated against the JSON Schema in this skill's `.config.schema.json`.

```yaml
specs:
  - id: interface_tui_results_presented-info
    description: One-line statement of the expected behavior.
    motivation: Why this behavior matters.
    acceptance_criteria:
      - Observable condition that means the spec is met.
    status: done
```

Each leaf file holds a `specs:` list of the specs whose ids map to that leaf. Entries are kept sorted alphabetically by `id` within each file, with a blank line between specs. `write` enforces this; a single write re-sorts an existing unsorted file.

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
  - `layers` — either a non-empty list of unique layer names matching `^[a-z0-9_]+$` (default `area`, `component`, `section` when the key is absent) or `false`.
  - `layers: false` — no layers are used: IDs are flat result terms with no hierarchy, `structure` must be omitted, and all specs live in the single `specs.spec.md`.
  - `structure` — required when `layers` is a list: a nested mapping as deep as `layers` minus one: each level maps term names to the next level, and the final level is a list of term names. Term names match `^[a-z0-9]+(?:-[a-z0-9]+)*$`.
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
When `layers` is `false`, the ID is a single flat result term: `presented-info` (no underscores).
The agent composes the ID from the project's declared taxonomy in `spec/.config.yaml`.

## Leaf files

A spec's leaf file is named after the layer parts of its ID, with a `.spec.md` extension:

- ID `interface_tui_results_presented-info` → `spec/interface_tui_results.spec.md`
- ID `presented-info` (no layers) → `spec/specs.spec.md`

`write` creates or updates the leaf file for the given ID; `read` and `find` search across every leaf file in the spec directory. `validate` additionally checks that every spec lives in the file named after its leaf.

## Actions

Run from anywhere in the repo; the script resolves the repo root itself. Any action may also take `--spec-dir <dir>` (in any position) to point at a different directory holding the `*.spec.md` files and `.config.yaml` — default is `<repo-root>/spec`.

```bash
bash <skill-dir>/spec.sh read --id <id>
bash <skill-dir>/spec.sh write --id <id> --description "<text>" --motivation "<text>" --acceptance-criteria "<criterion>" ["<criterion> ...] [--status <state>]
bash <skill-dir>/spec.sh find --query <keyword>
bash <skill-dir>/spec.sh validate
```

- `read` — prints the full spec YAML for `--id`.
- `write` — creates or updates a spec. All fields are taken directly as CLI arguments, so no temporary files are needed. The script validates the config, the schema (including `--status` when enabled), and the taxonomy before writing, keeps the leaf file sorted by id, and writes atomically. Reports `action=create` or `action=update`.
- `find` — case-insensitive substring match across id, description, motivation, acceptance criteria, and status (when enabled), over every leaf file; prints the matches as a YAML list of `id`/`description` mappings.
- `validate` — checks the config, that all spec IDs are unique, that every spec matches the schema, that status values are configured states, that IDs match the declared taxonomy, that every spec lives in its leaf file, and that every declared taxonomy term has at least one spec. Use it as a gate before committing spec or config changes.

## Output contract

The first stdout line is always a single key=value status line; exit 0 = success, 1 = failure, 2 = usage error.

- Success: `status=success action=<read|create|update|find|validate> ...`
  - `read`: the spec YAML follows after a blank line.
  - `write`: `path=<leaf file name>` names the file the spec was written to.
  - `find`: a YAML list of `id`/`description` mappings follows after a blank line.
  - `validate`: `specs=<n> has-status=<true|false> taxonomy=<checked|skipped>`.
- Failure: `status=failed reason=<reason>` plus context keys and, where relevant, a `problems:` block. Reasons:
  - `invalid-id` — id does not match `{layer1_..._layerN}_result` (or a flat result term when layers is false)
  - `yaml-error` — a spec file or the config is not valid YAML
  - `config-invalid` — `spec/.config.yaml` violates the skill's `.config.schema.json`
  - `schema-invalid` — an empty or invalid `--description`, `--motivation`, or `--acceptance-criteria` (write), or a spec field violation (validate)
  - `status-invalid` — `--status` missing, unknown, or passed while status is disabled
  - `taxonomy-unknown` — a layer term is not declared in the config taxonomy structure
  - `validate-failed` — duplicate IDs, schema/status/taxonomy violations, a spec in the wrong leaf file, or declared taxonomy terms with no specs
  - `not-found` — read of an unknown id (`known=` lists existing ids)
  - `spec-file-missing` — no `*.spec.md` files exist in the spec directory
  - `legacy-store` — a legacy `spec/SPECS.md` file exists; specs are partitioned into `*.spec.md` files
  - `malformed-store` — a `*.spec.md` file is not a `specs:` list of mappings
  - `io-error` — file read/write failure

## First-run setup (when spec/.config.yaml is missing)

1. Ask the user their status preference: no status, or which states they want.
2. Ask the user for the taxonomy: which layers — or none (`layers: false` for flat IDs) — and, when layers are declared, the structure.
3. Write `spec/.config.yaml` with the chosen `status` and the repo's taxonomy (migrate it from the existing `## Spec taxonomy` section in `AGENTS.md` if present).
4. If a legacy `spec/SPECS.md` exists, move its specs into the per-leaf `*.spec.md` files (or `specs.spec.md` when layers is false), then delete `SPECS.md`.
5. In `AGENTS.md`, remove the `## Spec taxonomy` section and add exactly this one line:
   `For spec structure and taxonomy, see spec/.config.yaml (managed by the spec-manager skill).`
6. Run `validate` and fix any problems.

## Creating a spec (workflow)

1. Read `spec/.config.yaml` (defaults apply when it is missing).
2. Add any new term to `taxonomy.structure` first (and `layers` if the taxonomy is new).
3. Compose the ID from the layer terms.
4. Run `write` with all fields as CLI arguments, plus `--status` when status is enabled.
5. Verify with `read` and `validate`.
6. Check the size of the leaf file that now holds the spec. If the leaf group is getting too big, follow "Refactoring a leaf" below before considering the work done.

## Refactoring a leaf (when a leaf group gets too big)

A leaf group is getting too big when its file holds more than about 10 specs, or when writing a new spec makes it noticeably the largest and most crowded leaf in the store. In that case do not just keep appending to it:

1. Use the `question` tool to present the user with concrete new taxonomy options for the crowded leaf. Offer a shortlist such as:
   - add a new layer below the leaf and split its terms into sub-terms;
   - split the leaf's last term into two or more sibling terms;
   - add a layer above the current top terms to rebalance the hierarchy.
   For each option, show the resulting layer names, the new leaf file names, and how the existing specs would be redistributed.
2. When the user picks an option, perform the full refactor:
   1. Update `taxonomy.layers` and `taxonomy.structure` in `spec/.config.yaml`.
   2. For every spec that moves, run `write` with its new ID, copying the description, motivation, acceptance criteria, and status from the old spec.
   3. Remove the old entries from their old leaf files, and delete any leaf file left empty.
   4. Run `validate` and fix any problems until the store passes.
3. Confirm the refactor: list the new leaf files and how many specs each holds.

## Testing

The skill ships with a CLI test suite. Each scenario under `tst/fixtures/<name>/` is a self-contained spec dir (per-leaf `*.spec.md` files plus an optional `.config.yaml`); `tst/spec.test.ts` runs the script against a copy of each fixture via `--spec-dir` and asserts on the exit code and output.

```bash
cd <skill-dir>
bun test          # run the happy/sad path suite (tst/spec.test.ts)
bunx tsc --noEmit # type-check spec.ts
```
