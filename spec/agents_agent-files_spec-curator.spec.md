specs:
  - id: agents_agent-files_spec-curator_agent-file
    description: The spec-curator agent file lives at agents/agent-files/spec-curator.md in primary mode
      with todowrite, doom_loop, and task denied.
    motivation: The curator works in the main conversation with the user, asks questions directly, and
      must not spawn subagents or maintain a todo list.
    acceptance_criteria:
      - agents/agent-files/spec-curator.md exists with frontmatter carrying a description, mode
        primary, and permission denials for todowrite, doom_loop, and task.
    status: done

  - id: agents_agent-files_spec-curator_audit-mode
    description: When the curator notices a discrepancy between the spec store and observed behavior, it
      surfaces it and offers a full audit; in audit mode it does a mid-level pass, verifying that
      specs recorded as implemented are actually implemented and looking for meaningful implemented
      behavior that has no spec, then presents all observed discrepancies with a recommended way to
      deal with each, via a single question tool call.
    motivation: "The store must stay honest: recorded as implemented means actually implemented, and
      meaningful behavior must not be missing from the store."
    acceptance_criteria:
      - A discrepancy noticed outside audit mode is surfaced to the user with an offer of a full
        audit.
      - "Audit output lists every observed discrepancy, each paired with a recommended action:
        update the spec, add a missing spec, change the status, or dismiss it, presented through one
        question tool call."
    status: done

  - id: agents_agent-files_spec-curator_decision-doors
    description: For one-way-door decisions the curator helps the user bottom them out and records the
      motivation in the spec for why the choice was picked over the alternatives; for two-way-door
      decisions the curator selects a reasonable default or presents a short list of options with
      the first one labeled recommended.
    motivation: User attention goes to hard-to-change choices and their rationale is preserved in the
      store, while easy-to-change choices do not stall progress.
    acceptance_criteria:
      - A spec for a one-way-door decision has a motivation field recording why the picked option
        was chosen over the alternatives.
      - A two-way-door decision is resolved by the curator with a default or a short options list,
        without a user round trip, unless the user objects.
    status: done

  - id: agents_agent-files_spec-curator_question-call
    description: Whenever the curator has pending clarifications at the end of a turn, it ends the turn
      with exactly one question tool call bundling all of them.
    motivation: The user can answer all pending questions in one pass instead of trading clarifications
      back and forth across turns.
    acceptance_criteria:
      - A turn with pending clarifications never ends without a question tool call.
      - All pending clarifications are in that single call, and the curator does not continue
        working after it.
    status: done

  - id: agents_agent-files_spec-curator_source-of-truth
    description: The curator treats the spec store as the primary source of truth for system state and
      does not do a deep dive of the codebase.
    motivation: The specs are the contract for the system, and an exhaustive code reading is expensive
      and drifts from that contract.
    acceptance_criteria:
      - Before proposing or refining a spec, the curator establishes current state with spec.sh
        validate, spec.sh find, and spec.sh read, plus the repo config.
      - Code inspection is limited to a mid-level pass during an audit, and the curator otherwise
        works from the spec store alone.
    status: done

  - id: agents_agent-files_spec-curator_spec-shape
    description: Specs written by the curator keep functional requirements as observable external
      behavior with programmatically verifiable acceptance criteria, keep infrastructure
      requirements such as framework and database choices as steering that is not directly verified,
      and avoid over-specification.
    motivation: Functional specs can be checked by a program, infrastructure specs steer implementation
      without bloating the store, and under-specification leaves room for easy-to-change choices.
    acceptance_criteria:
      - "Every functional spec carries acceptance criteria that are observable conditions: a
        command, an assertion on output, or a file in a given state."
      - Infrastructure specs state the choice and why it matters, and do not claim direct
        verification of the choice.
      - The curator adds no spec detail beyond what is needed to build and verify the behavior.
    status: done

  - id: agents_agent-files_spec-curator_spec-state-choice
    description: When the repo's spec/.config.yaml does not already specify a status setup, the curator
      walks the user through managing spec state in source control, which has less overhead and is
      agent-friendly but churns git history, versus no spec state, which uses an external backlog
      tracker and commits specs only once implemented, rather than assuming either.
    motivation: The status setup determines how the store is used and where the backlog lives, so it
      should be an explicit, recorded decision.
    acceptance_criteria:
      - The curator presents both approaches with their trade-offs before writing the first spec in
        a repo without a status config.
      - The chosen setup is written to spec/.config.yaml before any spec is written.
    status: done

  - id: agents_agent-files_spec-curator_spec-store-only
    description: The curator never modifies files outside spec/ and changes spec entries and the config
      only through the spec-manager skill.
    motivation: Every change to the spec store is traceable to a skill action and schema-validated, and
      the rest of the repo is left untouched.
    acceptance_criteria:
      - Every change to a spec entry in a per-leaf spec/*.spec.md file goes through spec.sh write.
      - spec/.config.yaml is only changed through the skill's config actions, and every config
        change is followed by a passing spec.sh validate.
      - The curator makes zero file modifications outside spec/.
    status: done

  - id: agents_agent-files_spec-curator_taxonomy-refinement
    description: The curator starts from the skill's default taxonomy or the existing spec/.config.yaml
      and refines the taxonomy layers as the project's scope becomes clear, adding new terms with
      the skill's config actions before writing the first spec that uses them.
    motivation: The taxonomy should grow with understanding of the project rather than being guessed up
      front, and spec IDs must always validate against it.
    acceptance_criteria:
      - A new taxonomy term is added with the skill's config actions before the first spec that uses
        it is written.
      - spec.sh validate passes after every taxonomy change.
    status: done

  - id: agents_agent-files_spec-curator_wired-opencode
    description: The spec-curator agent file is made available inside project containers by copying
      agents/agent-files into /home/agent/.config/opencode/agents, opencode's global markdown agents
      directory, at container start.
    motivation: "Copying the agent files into the container at start (rather than bind-mounting them
      live) keeps running containers stable: host-side edits to the agent files, or moving the repo,
      no longer change what a running container sees, and the container is recreated when its files
      should be refreshed."
    acceptance_criteria:
      - docker/docker-compose.yml has no bind mount of agents/agent-files, and the container start
        script generated by docker/Dockerfile copies agents/agent-files into
        /home/agent/.config/opencode/agents.
      - In a container started from the current compose file, the spec-curator agent is available as
        a primary agent inside opencode.
    status: done
