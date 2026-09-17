---
name: spec-manager
description: Creates, updates, reads, and searches spec entries stored as YAML in spec/SPECS.md. Use when asked to create a new spec, update an existing spec, read a spec by its ID, or find specs that match a keyword.
---

# Spec Manager Skill

Canonical specs live in one YAML file at the repo root: `spec/SPECS.md`.

```yaml
specs:
  - id: interface_tui_results_presented-info
    description: One-line statement of the expected behavior.
    motivation: Why this behavior matters.
    acceptance_criteria:
      - Observable condition that means the spec is met.
```

Entries are kept sorted alphabetically by `id`, which keeps specs in the same area/component/section grouped together and makes IDs easy to find by eye. `write` enforces this; a single write re-sorts an existing unsorted file.

## Schema

Every spec has exactly four fields; nothing else is accepted:

- `id` — stable unique identifier (format below)
- `description` — non-empty string
- `motivation` — non-empty string (why do we want this?)
- `acceptance_criteria` — non-empty string, or a non-empty list of strings (when is this met? observable conditions)

No workflow state, owner, status, or date fields: a canonical spec asserts expected current behavior.

## ID format

`{area}_{component}_{section}_{result}`, lowercase, with `-` in place of spaces.
Example: `interface_tui_results_presented-info` (area `interface`, component `tui`, section `results`, result `presented-info`).
The agent composes the ID from the project's declared taxonomy (below).

## Spec taxonomy in AGENTS.md

Each repo declares its vocabulary in its `AGENTS.md` under a `## Spec taxonomy` heading, and keeps it up to date as new terms are created. The taxonomy is a tree: areas contain components, and components contain sections, so which terms combine is visible:

```markdown
## Spec taxonomy

- interface
  - tui
    - results
    - input
  - cli
    - results
- data
  - store
    - persistence
```

The legacy flat list format (`- areas: ...`, `- components: ...`, `- sections: ...`) is still accepted and treats the three levels as independent lists.

Before creating a spec whose ID uses a new area, component, or section, add that term to the tree first. The `write` action validates the first three ID parts against the tree: the area, then the component under that area, then the section under that component. If the heading is absent, the check is skipped (`taxonomy=skipped`).

## Actions

Run from anywhere in the repo; the script resolves the repo root itself.

```bash
bash <skill-dir>/spec.sh read --id <id>
bash <skill-dir>/spec.sh write --id <id> --description "<text>" --motivation "<text>" --acceptance-criteria "<criterion>" ["<criterion> ...]
bash <skill-dir>/spec.sh find --query <keyword>
```

- `read` — prints the full spec YAML for `--id`.
- `write` — creates or updates a spec. All fields are taken directly as CLI arguments, so no temporary files are needed. The script validates the schema (and taxonomy) before writing, keeps the file sorted by id, and writes atomically. Reports `action=create` or `action=update`.
- `find` — case-insensitive substring match across id, description, motivation, and acceptance criteria; prints the matches as a YAML list of `id`/`description` mappings.

## Output contract

The first stdout line is always a single key=value status line; exit 0 = success, 1 = failure, 2 = usage error.

- Success: `status=success action=<read|create|update|find> ...`
  - `read`: the spec YAML follows after a blank line.
  - `find`: a YAML list of `id`/`description` mappings follows after a blank line.
- Failure: `status=failed reason=<reason>` plus context keys and, where relevant, a `problems:` block. Reasons:
  - `invalid-id` — id does not match `{area}_{component}_{section}_{result}`
  - `yaml-error` — the store is not valid YAML
  - `schema-invalid` — an empty or invalid `--description`, `--motivation`, or `--acceptance-criteria`
  - `taxonomy-unknown` — an area/component/section is not declared in the AGENTS.md spec taxonomy tree
  - `not-found` — read of an unknown id (`known=` lists existing ids)
  - `spec-file-missing` — `spec/SPECS.md` does not exist (read)
  - `malformed-store` — `spec/SPECS.md` is not a `specs:` list of mappings
  - `io-error` — file read/write failure

## Creating a spec (workflow)

1. Read the repo's `AGENTS.md` `## Spec taxonomy` section; add any new area/component/section there first.
2. Compose the ID: `{area}_{component}_{section}_{result}`.
3. Run `write` with all four fields as CLI arguments.
4. Verify with `read` (and `find` if useful).
