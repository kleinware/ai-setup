---
name: spec-manager
description: Creates, updates, deletes, reads, searches, queries, and validates spec entries stored as YAML in per-leaf spec/*.spec.yaml files, and manages the repo config spec/.config.yaml (status and taxonomy) through the skill CLI. Use when asked to create a new spec, update an existing spec, delete an existing spec, read a spec by its ID, find specs that match a keyword, query the repo config (status, layers, taxonomy), query specs by status and/or layer, validate the spec store and config, or change the config (status or taxonomy). Never edit or parse spec files or the config by hand; use the skill CLI.
---

# Spec Manager Skill

Canonical specs live in `spec/`, partitioned into one YAML file per taxonomy leaf: `spec/<layer terms>.spec.yaml` (for example `spec/interface_tui_results.spec.yaml`). When `taxonomy.layers` is `false` there is no hierarchy and all specs live in a single `spec/specs.spec.yaml`. Repo preferences for the skill live in `spec/.config.yaml`, validated against the JSON Schema in this skill's `.config.schema.json`.

```yaml
specs:
  - id: interface_tui_results_presented-info
    description: One-line statement of the expected behavior.
    motivation: Why this behavior matters.
    acceptance_criteria:
      - Observable condition that means the spec is met.
    status: done
    meta: arbitrary attached data (any non-null YAML value; optional)
```

Each leaf file holds a `specs:` list of the specs whose ids map to that leaf. Entries are kept sorted alphabetically by `id` within each file, with a blank line between specs. `write` enforces this; a single write re-sorts an existing unsorted file.

## Using the CLI (do not parse specs yourself)

Do not read, grep, or parse `spec/*.spec.yaml` or `spec/.config.yaml` with file or search tools. Every read, search, query, and change must go through the `spec.sh` CLI: use `query config` for the repo config (status, layers, taxonomy), `query tasks` to list specs by status and/or layer, `read` for a single spec, `find` for keyword search, and `validate` for store health. The CLI applies the same parsing and validation as the store, so its output is the single source of truth.

## Config: spec/.config.yaml

Never edit `spec/.config.yaml` directly — every change goes through the `config` actions in the skill's `spec.sh`, which validate the result against `.config.schema.json` and write the file atomically. Query its contents with `query config` rather than parsing the file yourself.

```yaml
status:
  - name: pending
    description: Not implemented yet.
  - name: done
    description: Implemented and verified.
taxonomy:
  layers: [area, component, section]
  structure:
    isolation:
      container: [access, persistence, setup]
      script: [output, setup]
```

- `status` — one of:
  - `false` — no status is used. A spec that is in source control is valid and approved, and work management happens outside the repo.
  - a non-empty list of `{name, description}` objects — every spec must carry `status` set to one of the names, and each name has a free-text description of what it means.
  - Missing key or missing file — no status (default).
  - Names match `^[a-z0-9_]+$` and are unique.
- `taxonomy` — optional:
  - `layers` — either a non-empty list of unique layer names matching `^[a-z0-9_]+$` (default `area`, `component`, `section` when the key is absent) or `false`.
  - `layers: false` — no layers are used: IDs are flat result terms with no hierarchy, `structure` must be omitted, and all specs live in the single `specs.spec.yaml`.
  - `structure` — required when `layers` is a list: a nested mapping as deep as `layers` minus one: each level maps term names to the next level, and the final level is a list of term names. Term names match `^[a-z0-9]+(?:-[a-z0-9]+)*$`.
  - Missing key — no taxonomy; the membership check is skipped (`taxonomy=skipped`).

Every action validates the config first; a broken config fails with `config-invalid` before anything else runs. Exception: `config set` validates only the resulting config, so it can run on — and fix — a broken one.

## Schema

Every spec has exactly four fields, plus `status` when status is enabled, and an optional `meta`; nothing else is accepted:

- `id` — stable unique identifier (format below)
- `description` — non-empty string
- `motivation` — non-empty string (why do we want this?)
- `acceptance_criteria` — non-empty string, or a non-empty list of strings (when is this met? observable conditions)
- `status` — required when status is enabled, one of the configured status names; forbidden when disabled
- `meta` — optional; arbitrary non-null YAML data (a string, number, list, or mapping), stored after `status` at the bottom of the spec YAML. It is matched by `find` and returned whenever the spec is printed (`read`, `find`, `query tasks`)

A spec's `meta` may contain a `change` key proposing a change. The object may contain only these keys:

- `description` — non-empty string, a full replacement of the spec's description
- `motivation` — non-empty string, a full replacement of the spec's motivation
- `acceptance_criteria` — an object whose zero-based numeric string index keys (`"0"`, `"1"`, ...) map to a string that replaces that criterion or to `false` that deletes it, and whose `new1`, `new2`, ... keys map to strings appended to the end of the list in key order
- `change_status` — `pending` or `approved`

`id`, `status`, and `meta` keys are not allowed inside it. `write` and `validate` reject change objects that violate this.

## ID format

`{layer1}_{layer2}_..._{layerN}_{result}`, where the layer names come from `taxonomy.layers` (default `area_component_section`), lowercase, with `-` in place of spaces.
Example: `interface_tui_results_presented-info` (area `interface`, component `tui`, section `results`, result `presented-info`).
When `layers` is `false`, the ID is a single flat result term: `presented-info` (no underscores).
The agent composes the ID from the project's declared taxonomy in `spec/.config.yaml`.

## Leaf files

A spec's leaf file is named after the layer parts of its ID, with a `.spec.yaml` extension:

- ID `interface_tui_results_presented-info` → `spec/interface_tui_results.spec.yaml`
- ID `presented-info` (no layers) → `spec/specs.spec.yaml`

`write` creates or updates the leaf file for the given ID; `read` and `find` search across every leaf file in the spec directory. `validate` additionally checks that every spec lives in the file named after its leaf.

## Actions

Run from anywhere in the repo; the script resolves the repo root itself. Any action may also take `--spec-dir <dir>` (in any position) to point at a different directory holding the `*.spec.yaml` files and `.config.yaml` — default is `<repo-root>/spec`.

```bash
bash <skill-dir>/spec.sh read --id <id> ["--include-history"]
bash <skill-dir>/spec.sh write --id <id> --description "<text>" --motivation "<text>" --acceptance-criteria "<criterion>" ["<criterion> ...] [--status <name>] [--meta <yaml>]
bash <skill-dir>/spec.sh upsert change --id <id> --change <yaml>
bash <skill-dir>/spec.sh delete --id <id>
bash <skill-dir>/spec.sh find --query <keyword> ["--include-history"]
bash <skill-dir>/spec.sh query config
bash <skill-dir>/spec.sh query tasks [--status <name>] [--layer <path> ...] ["--include-history"]
bash <skill-dir>/spec.sh validate
bash <skill-dir>/spec.sh config get
bash <skill-dir>/spec.sh config set [--status <name>:<description> ...] [--layers <layer> ...] [--structure <yaml>]
bash <skill-dir>/spec.sh config add --term <term> [--parent <path>]
bash <skill-dir>/spec.sh config remove --term <term> [--parent <path>]
```

- `read` — prints the full spec YAML for `--id`. When the spec's `meta` has a `history` key it is omitted unless `--include-history` is passed; all other meta fields are always printed.
- `write` — creates or updates a spec. All fields are taken directly as CLI arguments, so no temporary files are needed. `--meta` is optional and takes any non-null YAML value, stored after `status` at the bottom of the spec YAML. The script validates the config, the schema (including `--status` when enabled and `--meta` when present), and the taxonomy before writing, keeps the leaf file sorted by id, and writes atomically. A `--meta` containing a `change` key is validated against the change schema (see Schema) and fails with `schema-invalid` otherwise. Reports `action=create` or `action=update`.
- `upsert change` — merges the passed `meta.change` fields into the spec's existing `meta.change`, creating `meta.change` when the spec has none. Takes `--id` and `--change <yaml>`: the passed top-level keys (`description`, `motivation`, `change_status`) overwrite the existing ones, and `acceptance_criteria` merges individual index and `new` keys into the existing `acceptance_criteria` object (unpassed keys are preserved). `change_status` is set to `pending` unless passed. The resulting `meta.change` is validated against the change schema (see Schema) and fails with `schema-invalid` otherwise; all other spec fields are untouched. Saves the spec to its leaf file atomically (still sorted by id) and reports `action=upsert-change`. Fails with `not-found` when no spec has that id.
- `delete` — removes the spec with `--id` from its leaf file. The file is rewritten atomically with the remaining specs (still sorted by id), and the file is deleted when the removed spec was its last entry. Fails with `not-found` when no spec has that id.
- `find` — case-insensitive substring match across id, description, motivation, acceptance criteria, status (when enabled), and meta (when present), over every leaf file; prints the matches as a YAML list of `id`/`description` mappings, plus `meta` when present. A `meta.history` key is omitted unless `--include-history` is passed; all other meta fields are always printed.
- `query config` — prints the repo's spec config as normalized YAML: `status` (`false`, or the list of `{name, description}` objects), `layers` (`false`, or the list of layer names), and `structure` when present. Reports `file=missing` when `spec/.config.yaml` is absent.
- `query tasks` — lists the specs matching `--status <name>` and/or one or more `--layer <path>` flags; a layer path is `/`-separated layer terms and may be a partial path (for example `interface/tui` matches every spec under that branch, and multiple `--layer` flags are OR-ed). At least one of `--status` or `--layer` is required. Prints a YAML list of `id`/`description`/`status` (status only when enabled) mappings, plus `meta` (only when present). A `meta.history` key is omitted unless `--include-history` is passed; all other meta fields are always printed.
- `validate` — checks the config, that all spec IDs are unique, that every spec matches the schema (including validating `meta.change` values against the change schema), that status values are configured states, that IDs match the declared taxonomy, that every spec lives in its leaf file, and that every declared taxonomy term has at least one spec. Use it as a gate before committing spec or config changes.
- `config get` — prints the contents of `spec/.config.yaml`, or `file=missing` when the file is absent.
- `config set` — updates `spec/.config.yaml` (creating it when absent). Each flag present replaces that part; the other parts are preserved. `--status` takes one or more `<name>:<description>` entries, or a single `false` to disable status; the first `:` separates the name from the description and both must be non-empty (for example `wip:in progress`). `--layers` takes one or more layer names, or a single `false` for no layers, which drops the structure. `--structure` takes a YAML mapping of the full taxonomy structure. The resulting config is validated and written atomically.
- `config add` — adds a term to the taxonomy structure. `--parent` is the `/`-separated path to the list that receives the term (omit it for a single-layer taxonomy); `--parent` must point to a leaf list. Use `config set --structure` to create intermediate branches or change the layers.
- `config remove` — removes a term from the taxonomy structure: a leaf term from a list (`--parent` to the list), or a whole branch from a mapping. Parents left empty are pruned; the removal fails if it would leave the structure empty.

After any `config` change, run `validate`: a declared term without specs, or a spec whose ID no longer matches the taxonomy, is reported there.

## Output contract

The first stdout line is always a single key=value status line; exit 0 = success, 1 = failure, 2 = usage error.

- Success: `status=success action=<read|create|update|upsert-change|delete|find|query-config|query-tasks|validate|config-get|config-set|config-add|config-remove> ...`
  - `read`: the spec YAML follows after a blank line.
  - `write`: `path=<leaf file name>` names the file the spec was written to.
  - `upsert-change`: `path=<leaf file name>` names the file the spec was written to.
  - `delete`: `path=<leaf file name>` names the file the spec was removed from; the file is deleted when the removed spec was its last entry.
  - `find`: a YAML list of `id`/`description` mappings (plus `meta` when present) follows after a blank line.
  - `query-config`: the normalized config YAML follows after a blank line, or `file=missing` with no YAML.
  - `query-tasks`: a YAML list of `id`/`description`/`status` (status only when enabled) mappings (plus `meta` only when present) follows after a blank line; the status line echoes `status=<state>` and one `layer=<path>` per layer filter, plus `count=<n>`.
  - `validate`: `specs=<n> has-status=<true|false> taxonomy=<checked|skipped>`.
  - `config-get`: the config YAML follows after a blank line, or `file=missing` with no YAML.
  - `config-set`/`config-add`/`config-remove`: `path=spec/.config.yaml` names the file written; `add` and `remove` also report `term=<term>`.
- Failure: `status=failed reason=<reason>` plus context keys and, where relevant, a `problems:` block. Reasons:
  - `invalid-id` — id does not match `{layer1_..._layerN}_result` (or a flat result term when layers is false)
  - `yaml-error` — a spec file, the config, or a `--meta` value is not valid YAML
  - `config-invalid` — `spec/.config.yaml` (or the result of a `config` change) violates the skill's `.config.schema.json`
  - `config-missing` — `spec/.config.yaml` does not exist (for `config add` or `config remove`)
  - `schema-invalid` — an empty or invalid `--description`, `--motivation`, or `--acceptance-criteria` (write), a null `--meta` (write), a `meta.change` that violates the change schema (write, upsert change, and validate), or a spec field violation (validate)
  - `status-invalid` — `--status` missing, unknown, or passed while status is disabled
  - `taxonomy-unknown` — a layer term is not declared in the config taxonomy structure
  - `layer-invalid` — `--layer` passed while `taxonomy.layers` is `false`, or a layer path with the wrong number of terms
  - `term-not-found` — a `config add`/`config remove` term, or a term in the `--parent` path, is not declared in the taxonomy structure
  - `term-exists` — `config add` of a term that is already declared
  - `validate-failed` — duplicate IDs, schema/status/taxonomy violations, a spec in the wrong leaf file, or declared taxonomy terms with no specs
  - `not-found` — read or delete of an unknown id (`known=` lists existing ids)
  - `spec-file-missing` — no `*.spec.yaml` files exist in the spec directory
  - `legacy-store` — a legacy `spec/SPECS.md` file exists; specs are partitioned into `*.spec.yaml` files
  - `malformed-store` — a `*.spec.yaml` file is not a `specs:` list of mappings
  - `io-error` — file read/write failure

## First-run setup (when spec/.config.yaml is missing)

1. Ask the user their status preference: no status, or which states they want and a short description of each.
2. Ask the user for the taxonomy: which layers — or none (`layers: false` for flat IDs) — and, when layers are declared, the structure.
3. Run `config set` with the chosen `--status` and, when a taxonomy is declared, `--layers` and `--structure` (migrate those values from the existing `## Spec taxonomy` section in `AGENTS.md` if present).
4. If a legacy `spec/SPECS.md` exists, move its specs into the per-leaf `*.spec.yaml` files (or `specs.spec.yaml` when layers is false), then delete `SPECS.md`.
5. In `AGENTS.md`, remove the `## Spec taxonomy` section and add exactly this one line:
   `For spec structure and taxonomy, see spec/.config.yaml (managed by the spec-manager skill).`
6. Run `validate` and fix any problems.

## Creating a spec (workflow)

1. Read `spec/.config.yaml` (defaults apply when it is missing).
2. Add any new term with `config add` first (or `config set` for new layers or a new structure).
3. Compose the ID from the layer terms.
4. Run `write` with all fields as CLI arguments, plus `--status` when status is enabled and `--meta` when the spec carries attached data.
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
   1. Update the taxonomy with the `config` actions: `config set` for `--layers` and `--structure`, `config add` for new leaf terms, `config remove` for terms that no longer exist.
   2. For every spec that moves, run `write` with its new ID, copying the description, motivation, acceptance criteria, and status from the old spec.
    3. Run `delete` for every old entry; it removes the spec from its leaf file and deletes any leaf file left empty.
   4. Run `validate` and fix any problems until the store passes.
3. Confirm the refactor: list the new leaf files and how many specs each holds.

## Testing

The skill ships with a CLI test suite. Each scenario under `tst/fixtures/<name>/` is a self-contained spec dir (per-leaf `*.spec.yaml` files plus an optional `.config.yaml`); `tst/spec.test.ts` runs the script against a copy of each fixture via `--spec-dir` and asserts on the exit code and output.

```bash
cd <skill-dir>
bun test          # run the happy/sad path suite (tst/spec.test.ts)
bunx tsc --noEmit # type-check spec.ts
```
