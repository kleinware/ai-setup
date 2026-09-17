specs:
- id: tooling_spec-manager_specs_agent-output-yaml
  description: Structured output the skill returns to the agent is YAML.
  motivation: YAML is more token-efficient than JSON for agent-consumed output, matching the YAML-on-disk
    spec format.
  acceptance_criteria:
  - find --query returns matching specs as a YAML list of id and description mappings.
  - read --id returns the spec as YAML.
- id: tooling_spec-manager_specs_create-update
  description: The spec-manager skill can create, update, read, and search canonical spec entries stored
    as YAML in spec/SPECS.md.
  motivation: Keep intended behavior a durable, version-controlled artifact that agents can discover and
    manage without external trackers.
  acceptance_criteria:
  - read --id returns the full spec for a known id and fails with not-found otherwise.
  - write --id with all fields as CLI arguments validates the four-field schema and the AGENTS.md taxonomy
    before creating or updating spec/SPECS.md and keeps the file sorted by id.
  - find --query prints matching specs as a YAML list of id and description.
- id: tooling_spec-manager_specs_sorted-by-id
  description: Entries in spec/SPECS.md are stored sorted alphabetically by id.
  motivation: Makes it easier for a human to find a spec's id and keeps specs in the same area/component/section
    grouped together.
  acceptance_criteria:
  - After every write, the specs list in spec/SPECS.md is ordered alphabetically by id.
  - Specs sharing the same area, component, and section appear contiguously.
