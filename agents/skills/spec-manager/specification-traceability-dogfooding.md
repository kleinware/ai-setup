# Specification Traceability System — Dogfooding Design Notes

## Purpose

This document captures the current design direction for a lightweight specification and traceability system intended to be dogfooded in a new TypeScript library.

The goal is not to create a heavyweight requirements-management platform. The goal is to make intended behavior a first-class, version-controlled artifact that AI coding agents can discover, reason about, modify, validate, and trace through the implementation without requiring external issue trackers or proprietary connectors.

The core premise is that implementation code may become increasingly disposable or regenerable over time, while the durable artifact is the specification of what the system is expected to do.

---

## Core principles

### 1. Specifications are durable source artifacts

Specifications should live in source control alongside the code.

They are intended to represent the authoritative description of the system's required behavior and constraints, rather than transient project-management state.

A clone of the repository should contain enough information for an agent to understand:

- what the system is expected to do;
- why significant implementation logic exists;
- what proposed changes are waiting to be implemented;
- how code and tests relate back to requirements.

### 2. Canonical specs describe the current expected system

A specification that appears in the canonical specification set should be treated as expected current behavior.

Canonical specs should therefore not carry workflow statuses such as:

- proposed;
- in progress;
- assigned;
- accepted;
- completed.

Those concepts belong elsewhere.

The intended invariant is:

> If a spec is canonical, the implementation is expected to satisfy it.

This keeps the specification set clean and prevents it from becoming a project-management database.

### 3. Functional specs should describe observable behavior

Functional specifications should focus on externally observable behavior rather than implementation structure.

Examples of suitable concerns:

- given a particular input, the library returns a particular result;
- when a condition occurs, an event is emitted;
- invalid input is rejected with a defined error;
- state transitions produce specified externally visible effects.

This is intended to reduce the risk that specs accidentally lock in implementation details and make future refactoring unnecessarily difficult.

A useful test is:

> Could this requirement still be valid if the implementation were completely rewritten?

If not, it may be describing implementation rather than behavior.

### 4. Non-functional specs describe constraints on behavior

The initial spec types should be:

- `functional`
- `non-functional`

Non-functional specs can capture requirements such as:

- performance budgets;
- latency;
- throughput;
- memory usage;
- resource consumption;
- compatibility;
- reliability;
- durability;
- security properties;
- operational constraints.

This provides a place for requirements that matter but are not naturally expressed as input/output behavior.

More spec types may be added later if a real need emerges, but the initial design should remain deliberately small.

### 5. Stable, unique spec identifiers

Each specification item should have a stable unique identifier.

The identifier is the primary traceability key used by:

- implementation code;
- tests;
- validation tooling;
- generated reports;
- proposed changes;
- code review;
- agents.

Identifiers should survive wording changes whenever the underlying requirement remains conceptually the same.

The exact naming convention is intentionally undecided during initial dogfooding. The important property is uniqueness and stability.

---

## Specification storage format

The current preference is a structured, token-efficient format such as YAML rather than Markdown as the canonical machine-readable representation.

Reasons include:

- easy deterministic parsing;
- compact representation;
- straightforward schema validation;
- easy traversal by AI agents;
- reduced ambiguity around structure;
- easy generation of alternate human-readable documentation;
- convenient use as input to build-time tooling.

The schema should remain intentionally minimal.

A conceptual example:

```yaml
component: cache

specs:
  - id: CACHE-001
    type: functional
    behavior: Repeated reads of the same key return the stored value until it expires.

  - id: CACHE-002
    type: non-functional
    behavior: Cached reads should complete within the defined latency budget under the benchmark workload.
```

This example is illustrative rather than normative.

Avoid turning the format into a full requirements-management schema containing ownership, scheduling, estimates, comments, workflow state, or implementation details.

Human-oriented Markdown documentation can be generated from the structured specification files if useful.

---

## Traceability into implementation code

### Intent

Meaningful implementation logic should be traceable back to the specification or specifications that justify its existence.

The purpose is to support both directions of analysis:

**From code to spec**

> Why does this logic exist?

**From spec to code**

> Where is this behavior implemented, tested, or otherwise enforced?

This may help identify:

- dead code;
- obsolete behavior;
- stale implementation paths;
- requirements with no apparent implementation;
- implementation behavior with no corresponding requirement;
- unexpected coupling between requirements and implementation.

### Do not annotate every line

The system should not require a spec reference on every line or every syntactic block.

The desired scope is semantic rather than syntactic.

A useful rule of thumb is:

> Annotate the smallest meaningful implementation region that has an independent behavioral reason to exist.

Another way to think about it:

> If removing or changing this logic would alter externally observable behavior or violate a non-functional constraint, it should probably be traceable to a spec.

Pure implementation mechanics generally do not need their own spec references.

Examples that may deserve traceability:

- a branch implementing a defined edge case;
- a validation rule;
- a retry policy required by a reliability constraint;
- a serialization decision required for compatibility;
- a cache behavior required by a performance requirement;
- a public API behavior.

Examples that may not:

- temporary variables;
- straightforward plumbing;
- local refactors with no behavioral meaning;
- mechanical language/runtime boilerplate.

Dogfooding should be used to refine what the correct annotation granularity feels like in practice.

---

## Structured / executable spec references

Spec references in code should ideally be more structured than ordinary comments.

The exact TypeScript API is intentionally undecided, but possible directions include:

```ts
spec("CACHE-001")
```

or:

```ts
withSpec("CACHE-001", () => {
  // implementation
})
```

or metadata attached to functions, branches, tests, or other constructs.

The desired properties are:

- machine-readable;
- statically discoverable where possible;
- cheap for agents to insert and maintain;
- removable or erasable in production builds if they impose runtime cost;
- usable during debug, validation, or test builds;
- capable of producing traceability information.

The system should avoid adding meaningful production overhead merely for traceability.

---

## Build-time spec registry and validation

A build or validation step should parse all specification files and build a registry of known spec identifiers.

That registry can be used to detect several classes of problems.

### Unknown references

Implementation or test code references a spec ID that does not exist.

This is likely a strong error candidate.

### Unreferenced specifications

A canonical spec exists but appears nowhere in code, tests, benchmarks, or another validation mechanism.

This should be reported.

Whether it is initially a warning or build failure should be determined through dogfooding.

### Referenced specifications

The tooling should be able to report all implementation and test references associated with a spec.

This supports forward traceability.

### Orphaned implementation logic

It may eventually be useful to detect meaningful implementation regions that have no spec association.

This is harder to define mechanically and may initially be an agent-assisted review rather than a strict compiler rule.

---

## Runtime / validation-build observation

One particularly promising idea is to make spec references observable during debug, test, or validation builds.

For example, when code associated with a spec executes, the system could record that the spec ID was "hit."

This could produce a runtime view such as:

- known specs;
- statically referenced specs;
- specs observed during execution;
- specs never observed during the validation suite;
- runtime references to unknown specs.

This resembles coverage, but it is **spec coverage**, not line coverage.

That distinction matters.

A spec being "hit" does not prove that the requirement is satisfied. It only proves that some code associated with the requirement executed.

The runtime data should therefore be treated as diagnostic evidence, not proof of correctness.

Ideally, production builds can erase these hooks or compile them to no-ops.

---

## Tests and specifications

Functional specs should generally be linked to black-box or externally observable tests wherever practical.

Tests are an important enforcement layer because they help keep specifications focused on behavior rather than implementation.

A test may reference one or more spec IDs.

For example:

```ts
test.spec("CACHE-001", "returns a stored value before expiry", () => {
  // ...
})
```

The exact API is open.

Non-functional specs may need different validation mechanisms, such as:

- benchmark suites;
- load tests;
- compatibility suites;
- security checks;
- resource-budget checks;
- static analysis.

The traceability system should not assume every spec maps cleanly to a unit test.

---

## Bug fixes and spec changes

A code change that fixes a bug does **not** necessarily require a canonical spec change.

Two distinct cases should be recognized.

### Implementation defect

The existing spec already describes the correct intended behavior, but the implementation violates it.

In this case:

- update the implementation;
- add or improve tests if necessary;
- keep the existing spec;
- preserve or add the appropriate spec references.

### Specification gap

The discovered behavior was not represented in the specification, or the desired behavior itself needs refinement.

In this case:

- refine or add the spec;
- update implementation and tests;
- preserve the lesson in the canonical specification.

This distinction is important.

If every bug automatically creates or mutates a spec, the specification can gradually become a catalog of historical implementation accidents rather than a clean description of intended behavior.

The goal is to "learn once" without blindly ossifying every observed quirk.

---

## Desired change invariant

A useful development invariant is:

> A behavior-changing code change should be explainable in terms of one or more specification IDs.

That does not mean every commit must modify the specification files.

A change may simply bring implementation back into compliance with an existing spec.

However, a behavioral change that cannot be connected to a specification should be treated as suspicious.

This provides a strong review question:

> What requirement justifies this behavioral change?

---

## Proposed work versus canonical specifications

Canonical specifications represent current expected behavior.

Future changes should therefore not be inserted directly into the canonical spec set before implementation if doing so would make the repository temporarily assert behavior that does not yet exist.

Instead, the repository should contain a separate concept of a **proposal** or **work item**.

A proposal represents an intended change to the canonical specification.

The proposed change may include the future specification text itself.

For example:

```text
proposals/
  add-cache-expiration.yaml
```

Conceptually:

```yaml
id: add-cache-expiration

adds:
  - id: CACHE-003
    type: functional
    behavior: An expired entry is treated as absent.

context:
  - CACHE-001
```

Again, this is illustrative.

The proposal format should remain lightweight and should not become a general-purpose issue tracker.

---

## Why proposals should live on the main branch

The current direction is that proposals should be committed to the main branch in a clearly separate location from canonical specs.

This gives agents repository-local visibility into future work.

A fresh clone can reveal:

- current expected behavior;
- proposed changes;
- the implementation;
- tests and validation;
- traceability information.

This avoids requiring an agent to connect to:

- GitHub Issues;
- Jira;
- Linear;
- a custom project-management API;
- another external coordination system;

merely to discover that work exists.

This is especially useful for agent-driven development where portability and autonomous repository inspection are priorities.

---

## Proposal lifecycle

A simple lifecycle might be:

1. Someone has an idea.
2. Discussion and design happen.
3. Maintainers agree the change should be implemented.
4. A proposal is committed to main.
5. An agent claims the proposal through an ephemeral coordination mechanism.
6. The agent implements the change in a branch/worktree.
7. The implementation includes:
   - canonical spec additions or modifications;
   - code changes;
   - tests / benchmarks / other validation;
   - spec references.
8. The implementation commit or merge removes the proposal.
9. After merge, the canonical spec set again describes the current expected system.

This creates a useful repository-level state transition:

```text
proposal exists
    ↓
implementation work occurs
    ↓
proposal disappears
canonical spec appears or changes
implementation satisfies it
```

The proposal is durable intent.

The canonical spec is durable truth.

---

## Work-in-progress coordination

The repository should not be expected to solve all concurrency coordination through Git commits.

If multiple agents can work simultaneously, some ephemeral mechanism is required to prevent two agents from unintentionally implementing the same proposal.

Possible approaches include:

- a controller-owned claim;
- a lease;
- a sandbox allocation;
- a worktree allocation;
- another small piece of ephemeral orchestration state.

A useful model is:

> The proposal says work exists.  
> The claim says someone is currently working on it.

The claim should probably **not** be committed to the main branch.

Reasons:

- claims are transient;
- they create noisy repository churn;
- they can become stale;
- they are coordination state, not durable product knowledge.

In an agent orchestration environment, the existence of an allocated worktree or sandbox may itself serve as the claim.

This is intentionally a small exception to the goal of making everything repository-local.

Some ephemeral state is unavoidable for concurrent execution, and that is acceptable.

---

## Separation of concerns

The current architecture distinguishes three different concepts.

### Canonical specification

**Question answered:** What should the system do now?

Durable. Version controlled. Expected to be satisfied.

### Proposal

**Question answered:** What change have maintainers agreed should be made?

Durable enough to commit to the repository. Discoverable by agents. Deleted when implemented.

### Claim / lease

**Question answered:** Is someone already working on this proposal?

Ephemeral coordination state. Not part of the canonical repository history.

Keeping these separate avoids mixing product truth, future intent, and execution state.

---

## Agent-oriented design goals

The system should be optimized for autonomous coding agents.

An agent should be able to clone the repository and answer questions such as:

- What behavior is required?
- What non-functional constraints exist?
- What changes have been proposed?
- Which proposal should I implement?
- Which specs does this code implement?
- Which tests validate this spec?
- Which specs have no implementation references?
- Which references point to nonexistent specs?
- What changed in the spec as part of this feature?
- Does this code change introduce behavior with no corresponding requirement?

The system should favor simple files, deterministic tooling, and local inspection over APIs and connector dependencies.

---

## What this system is not

At least initially, this should **not** attempt to become:

- a full issue tracker;
- sprint-management software;
- an assignee database;
- a discussion system;
- a replacement for code review;
- a formal verification system;
- proof that the implementation is correct;
- a requirement to formally specify every line of code.

Keeping the scope narrow is important.

---

## Important tradeoffs

### Structured specs versus Markdown

**Structured formats such as YAML**

Advantages:

- deterministic parsing;
- compact;
- schema validation;
- agent-friendly;
- easy to build tooling around.

Disadvantages:

- less pleasant for long prose;
- can create an illusion of formality or completeness;
- YAML itself has syntactic quirks;
- large requirements can become awkward.

A reasonable direction is structured canonical data with generated human-facing Markdown when needed.

### Extensive code annotations versus maintenance burden

More references provide better traceability.

However, excessive annotations can:

- create noise;
- make refactors tedious;
- become mechanically maintained without thought;
- encourage meaningless tagging simply to satisfy tooling.

Because agents are expected to perform much of the maintenance, the labor cost is lower than in a human-only codebase, but the semantic-quality concern remains.

Dogfooding should determine the useful annotation granularity.

### Runtime coverage versus false confidence

Runtime spec hits are potentially very useful, but:

> "This spec ID executed" is not equivalent to "this requirement was satisfied."

A coverage report must not imply correctness that it cannot establish.

### Repository-local work versus external project management

Keeping proposals in Git makes work discoverable to agents without connectors.

However, Git is not inherently good at:

- discussion;
- prioritization;
- scheduling;
- cross-project planning;
- real-time locking;
- assignments.

The system should avoid rebuilding a full project-management product inside the repository.

External tools may still be useful for human planning, while the repository contains the minimum durable intent agents need.

---

## Existing concerns and failure modes

### 1. False precision

A structured YAML spec can look formal while still containing ambiguous natural language.

Machine-readable structure does not make the semantics mathematically precise.

The system should avoid treating schema validity as proof that a requirement is well defined.

### 2. Goodharting the checks

Agents may optimize for the traceability metrics themselves.

Examples:

- tagging arbitrary code with a spec ID merely to eliminate an "unreferenced spec" warning;
- executing a code path solely so the spec appears covered;
- attaching broad specs to huge portions of the codebase;
- adding low-value tests just to satisfy coverage counts.

Traceability checks should be treated as signals rather than unquestionable quality metrics.

### 3. Specification incompleteness

Even a well-maintained spec set will likely omit things.

Common omissions may include:

- operability;
- security;
- compatibility;
- error behavior;
- resource limits;
- deployment assumptions;
- obscure but important user expectations.

The functional / non-functional split helps, but does not solve completeness.

### 4. Accidental behavior becoming permanent

Production systems develop quirks.

When a quirk is discovered, maintainers must decide whether it is:

- desirable behavior that should become a spec;
- a compatibility constraint;
- an implementation bug that should be removed.

Automatically promoting every observed behavior into a spec would fossilize mistakes.

### 5. Over-specification

If specs encode too much implementation detail, refactoring becomes difficult and the specification ceases to represent true behavioral intent.

Functional specs should remain observable whenever possible.

### 6. Stale traceability

Spec references can become technically valid but semantically wrong after refactoring.

A build can verify that an ID exists, but it cannot necessarily prove that the referenced code really implements that requirement.

Agent-assisted semantic review may be necessary.

### 7. Granularity remains unresolved

There is not yet a formal answer for how large a code region a spec reference should cover.

The current principle is semantic:

> reference meaningful logic with an independent behavioral reason to exist.

Dogfooding is expected to reveal better conventions.

### 8. Non-functional validation is heterogeneous

Performance, security, compatibility, and reliability requirements do not all fit one validation mechanism.

The framework should support multiple evidence types rather than forcing every spec into a test-shaped model.

### 9. Proposal schema could grow uncontrollably

Once proposal files exist, there will be pressure to add:

- priority;
- owner;
- timestamps;
- comments;
- dependencies;
- estimates;
- status;
- history.

That would gradually recreate an issue tracker.

Resist this unless repository-local project management becomes an explicit goal.

### 10. Claims require ephemeral infrastructure

Pure Git cannot provide a clean, reliable real-time lease between concurrent agents.

A tiny amount of controller or orchestration state is likely necessary.

This is acceptable and preferable to polluting the durable repository model with transient locks.

---

## Initial TypeScript dogfooding scope

The first implementation should remain intentionally small.

A reasonable first milestone would support:

1. YAML specification files.
2. Stable spec IDs.
3. `functional` and `non-functional` spec types.
4. A parser and schema validator.
5. A registry of known spec IDs.
6. A lightweight TypeScript API for associating code with spec IDs.
7. A lightweight test API or test metadata convention for associating tests with spec IDs.
8. A validation command that reports:
   - unknown spec references;
   - canonical specs with no references;
   - references grouped by spec.
9. Optional runtime collection of spec hits in validation/test builds.
10. A production mode in which runtime instrumentation can be eliminated.
11. A minimal `proposals/` convention.
12. No built-in issue tracker, assignment system, or persistent "in progress" state.

The first version should prioritize learning over completeness.

---

## Questions to answer through dogfooding

The dogfooding project should deliberately collect experience around the following unresolved questions:

- What spec ID naming convention feels natural?
- Should specs be grouped by component, package, capability, or another unit?
- What is the right code annotation granularity?
- Should spec references be function wrappers, decorators, comments parsed by tooling, tagged expressions, generated metadata, or something else?
- Can references be made type-safe?
- How much runtime overhead does instrumentation introduce?
- Should "canonical spec has no references" be a warning or an error?
- Which kinds of specs legitimately have no direct implementation reference?
- How should benchmarks and other non-test evidence reference specs?
- Should generated documentation be part of the library?
- What proposal structure is minimally sufficient?
- How should a proposal represent modifications to existing specs?
- How should deletions or deprecations of existing specs be represented?
- Should implementation commits contain machine-readable references to the proposal they satisfy?
- How well can agents maintain semantic traceability over repeated refactors?
- Which checks provide genuine value and which merely encourage metric gaming?

---

## Design philosophy for the first implementation

Prefer:

- simple over comprehensive;
- deterministic over heuristic where possible;
- repository-local over connector-dependent;
- behavioral intent over implementation detail;
- durable truth over workflow metadata;
- warnings and reports before hard enforcement;
- dogfooding evidence over premature abstraction.

The system should earn additional complexity through demonstrated need.

A useful mental model is a very small linker:

- specs define symbols;
- code, tests, benchmarks, and proposals reference symbols;
- tooling resolves those references;
- validation reports missing, unknown, stale, or suspicious relationships.

The long-term value is not the YAML or the annotations themselves.

The value is preserving a navigable relationship between:

**why the system behaves a certain way, what the repository says it should do, how that behavior is implemented, and how it is validated.**
