---
name: pre-push-verification
description: Reviews the commits that would be pushed to an origin remote and produces a findings report covering commit-message policy, exposed secrets or keys, possible PII, and suspicious or unintended changes. Use before pushing or when asked to audit unpushed commits. This skill reports only; it does not fetch, rewrite commits, or push.
---

# Pre-push Verification

Audit the exact commits currently ahead of the destination remote and give the user a concise Markdown report. Deterministic tools identify candidates; the agent must investigate every candidate and add its own reasoned opinion. Treat the audit as read-only: do not fetch, modify files or commits, contact secret-verification services, or push.

## Isolated runtime

Run the bundled `run.sh`; do not invoke `scripts/verify_push.py` directly. On first use, the launcher automatically creates a versioned virtual environment under `${XDG_CACHE_HOME:-$HOME/.cache}/pre-push-verification`, installs the pinned Python dependencies and spaCy model there, and downloads a pinned, SHA-256-verified Gitleaks binary into that same private runtime. It does not modify the repository, system Python, or global executable path. Later runs reuse the cache. `PRE_PUSH_VERIFICATION_CACHE` may override the cache location.

First use requires network access and can take several minutes. If the environment requires approval for downloads, request it for the launcher command. A setup failure is a coverage failure: report it and stop instead of bypassing the launcher.

The runtime provides:

- Gitleaks (`gitleaks`) for secrets in Git history.
- gitlint (`gitlint`) for commit-message rules. Respect a repository `.gitlint` configuration when present.
- Microsoft Presidio (`presidio-analyzer` with `en_core_web_sm`) for possible PII.

The scanner still reports each dependency's status. An unexpected unavailable or failed dependency is a coverage gap that must appear in the final report; never describe its check as passed. Narrow built-in patterns provide degraded secret/PII coverage but do not replace Gitleaks or Presidio.

## Run the evidence scanner

From the repository root, run:

```bash
bash <skill-dir>/run.sh
```

The script chooses the base in this order:

1. the current branch's upstream, when it is on `origin`;
2. `origin/<current-branch>`;
3. `origin/HEAD` (the remote default branch), for a new branch.

If the intended destination differs, rerun with its local remote-tracking ref or commit:

```bash
bash <skill-dir>/run.sh --base origin/main
```

To audit a user-specified commit range instead, provide both endpoints. Both the start and end commits are included:

```bash
bash <skill-dir>/run.sh --start <commit> --end <commit>
```

The start must be an ancestor of the end. `--start` and `--end` must be supplied together and cannot be combined with `--base`. In this mode, review every commit reported by the inclusive range rather than using the remote-oriented `<base>..HEAD` commands below.

The script never fetches. State the base and head in the final report so the user can see which locally cached remote state was audited. If no safe base can be resolved, stop and ask for the intended remote branch; do not guess from an unrelated local branch.

## Evaluate every candidate

The scanner supplies numbered candidates, not conclusions. For every candidate, inspect enough local context to assign one disposition: `confirmed`, `likely issue`, `needs review`, or `false positive`. Never omit a candidate merely because another tool reported the same underlying text; instead cross-reference duplicates and give each candidate a disposition.

- Inspect the relevant commit and a small surrounding section with `git show <sha> -- <path>`. Expand the context only as needed.
- For secret candidates, distinguish credentials from examples, placeholders, hashes, public identifiers, and test fixtures. Do not print the matched value. Do not test a credential against a provider.
- For PII candidates, consider the entity type, surrounding semantics, whether the data identifies a real person, and whether the repository legitimately requires it.
- For commit-message candidates, apply the repository's `AGENTS.md`, hooks, contribution guidance, and `.gitlint` policy. Explain whether the tool's generic rule is applicable here.

## Perform the LLM anomaly review

Review the scanner's complete commit-message and changed-file inventories even when no tool produced candidates. This portion is deliberately agent-driven:

- Read applicable `AGENTS.md` files, commit hooks, and contribution guidance. Compare every subject with those rules and with the files changed by that commit.
- Inspect the range's `git diff --stat`, `git diff --summary`, name/status changes, and per-commit stats. Look for messages that misrepresent their changes, unrelated files, generated output, build artifacts, debug logging, disabled checks, surprising executable-bit/symlink changes, large or binary files, lockfile-only drift, destructive migrations, broad configuration changes, and anomalous filenames.
- When something looks unusual, create an agent-identified item and investigate only the relevant commits, files, and surrounding diff text deeply enough to form an opinion. Trace imports, callers, configuration, or history when that context affects the judgment. Do not dump unrelated complete files into context.
- If nothing looks unusual, state that the inventories and summaries were reviewed and no LLM-identified anomaly was found. Do not manufacture findings.
- Inspect commits individually when needed to catch a concern introduced and later removed. Never reproduce a suspected credential or PII value in output.
- If a real credential may have entered any commit, mark it critical and advise revocation/rotation plus removal from all affected history. Merely deleting it in a later commit is insufficient.

Do not run project tests unless the user asks for broader pre-push testing. This skill audits the push contents; it does not substitute for the repository's normal test workflow.

## Report contract

Return a Markdown report with:

- **Range reviewed:** base and head for a push audit, or inclusive start and end for an explicit range; also include the branch and commit count.
- **Verdict:** `clear`, `needs attention`, or `blocked` (likely credential/private-key exposure).
- **Candidate evaluations:** include every scanner candidate ID, severity, tool/category, commit/file/location, the agent's disposition and reasoning, and remediation when applicable. Keep false positives in this section so the report accounts for every identified item.
- **LLM-identified items:** unusual commit/file/change observations found independently by the agent, each with the inspected evidence, opinion, confidence, and remediation. Say `None` when there are none.
- **Coverage and limitations:** status of Gitleaks, gitlint, and Presidio; contextual checks performed; any skipped/binary/truncated content; and whether local remote-tracking state was used without fetching.

The final verdict must reflect the agent's evaluations, not raw tool severity alone. A clean report requires that every candidate was evaluated as a false positive, no LLM anomaly was found, and no material coverage gap remains. It is not a guarantee that the push is safe.
