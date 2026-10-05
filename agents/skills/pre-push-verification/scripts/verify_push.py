#!/usr/bin/env python3
"""Read-only evidence scanner for commits that would be pushed."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass


@dataclass
class Finding:
    severity: str
    category: str
    location: str
    message: str


def git(*args: str, check: bool = True) -> str:
    result = subprocess.run(
        ["git", *args], text=True, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, check=False,
    )
    if check and result.returncode:
        raise RuntimeError(result.stderr.strip() or f"git {' '.join(args)} failed")
    return result.stdout


def ref_exists(ref: str) -> bool:
    return subprocess.run(
        ["git", "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    ).returncode == 0


def resolve_base(explicit: str | None, branch: str) -> tuple[str, str]:
    if explicit:
        if not ref_exists(explicit):
            raise RuntimeError(f"base does not resolve to a commit: {explicit}")
        return explicit, "explicit"

    upstream = git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}", check=False).strip()
    if upstream.startswith("origin/") and ref_exists(upstream):
        return upstream, "upstream"
    same_name = f"origin/{branch}"
    if branch and ref_exists(same_name):
        return same_name, "same-name remote branch"
    remote_head = git("symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD", check=False).strip()
    if remote_head and ref_exists(remote_head):
        return remote_head, "origin default branch"
    raise RuntimeError("cannot resolve a base; pass --base <origin/ref-or-commit>")


SECRET_PATTERNS = [
    ("critical", "private key", re.compile(r"-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----")),
    ("critical", "AWS access key", re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")),
    ("critical", "GitHub token", re.compile(r"\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{30,255}\b")),
    ("critical", "Slack token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("high", "JWT", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b")),
    ("high", "assigned secret", re.compile(
        r"(?i)\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd)\b\s*[:=]\s*['\"]?([^\s'\"#,;]{8,})"
    )),
]

PII_PATTERNS = [
    ("possible SSN", re.compile(r"(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)")),
    ("possible email address", re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.I)),
    ("possible North American phone number", re.compile(r"(?<!\d)(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}(?!\d)")),
]


def safe_fingerprint(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()[:10]


def scan_messages(commits: list[str]) -> list[Finding]:
    findings: list[Finding] = []
    for commit in commits:
        raw = git("show", "-s", "--format=%H%x00%s%x00%B", commit)
        parts = raw.strip("\n").split("\x00")
        if len(parts) < 3:
            continue
        sha, subject, body = parts[0], parts[1], parts[2]
        loc = sha[:12]
        if len(subject) > 72:
            findings.append(Finding("medium", "commit message", loc, f"subject is {len(subject)} characters (recommended maximum: 72)"))
        if re.match(r"(?i)^(?:wip|tmp|fixup!|squash!)\b", subject.strip()):
            findings.append(Finding("high", "commit message", loc, "subject appears temporary or history-rewrite-oriented"))
        for line_no, line in enumerate(body.splitlines()[1:], 2):
            if len(line) > 100 and not re.match(r"\s*(?:https?://|Co-authored-by:)", line, re.I):
                findings.append(Finding("low", "commit message", f"{loc}:message:{line_no}", f"body line is {len(line)} characters"))
    return findings


def scan_diff(diff: str, commit: str) -> tuple[list[Finding], int]:
    findings: list[Finding] = []
    path = "unknown"
    new_line = 0
    scanned = 0
    seen: set[tuple[str, str, str]] = set()
    for line in diff.splitlines():
        if line.startswith("+++ b/"):
            path = line[6:]
        elif line.startswith("@@"):
            match = re.search(r"\+(\d+)", line)
            new_line = int(match.group(1)) if match else 0
        elif line.startswith("+") and not line.startswith("+++"):
            content = line[1:]
            scanned += 1
            location = f"{commit[:12]}:{path}:{new_line}"
            for severity, label, pattern in SECRET_PATTERNS:
                match = pattern.search(content)
                if match:
                    value = match.group(1) if match.lastindex else match.group(0)
                    key = (label, path, safe_fingerprint(value))
                    if key not in seen:
                        seen.add(key)
                        findings.append(Finding(severity, "secret exposure", location, f"{label} pattern matched (redacted fingerprint {key[2]})"))
            for label, pattern in PII_PATTERNS:
                match = pattern.search(content)
                if match:
                    key = (label, path, safe_fingerprint(match.group(0)))
                    if key not in seen:
                        seen.add(key)
                        findings.append(Finding("medium", "possible PII", location, f"{label} matched (value redacted; fingerprint {key[2]})"))
            new_line += 1
        elif line.startswith(" "):
            new_line += 1
    return findings, scanned


def scan_added_lines(commits: list[str]) -> tuple[list[Finding], int]:
    """Scan every commit so a value added and later removed is still detected."""
    findings: list[Finding] = []
    scanned = 0
    for commit in commits:
        diff = git("show", "--format=", "--no-ext-diff", "--unified=0", "--find-renames", commit)
        commit_findings, commit_scanned = scan_diff(diff, commit)
        findings.extend(commit_findings)
        scanned += commit_scanned
    return findings, scanned


def revision_arguments(commits: list[str]) -> list[str]:
    """Return git-log arguments selecting exactly the resolved commit set."""
    if not commits:
        return []
    parents = git("show", "-s", "--format=%P", commits[0]).split()
    arguments = [commits[-1]]
    if parents:
        arguments.extend(["--not", *parents])
    return arguments


def run_gitleaks(commits: list[str]) -> tuple[list[Finding], str]:
    executable = shutil.which("gitleaks")
    if not executable:
        return [], "unavailable (built-in secret patterns used as degraded fallback)"
    if not commits:
        return [], "completed (empty range)"
    log_opts = " ".join(revision_arguments(commits))
    with tempfile.TemporaryDirectory(prefix="pre-push-gitleaks-") as temp_dir:
        report = f"{temp_dir}/report.json"
        try:
            result = subprocess.run(
                [executable, "git", "--log-opts", log_opts, "--report-format", "json",
                 "--report-path", report, "--redact", "--exit-code", "0", "."],
                text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
            )
        except OSError as exc:
            return [], f"failed to execute ({exc})"
        if result.returncode:
            detail = (result.stderr or result.stdout).strip().splitlines()
            return [], f"failed (exit {result.returncode}: {detail[-1] if detail else 'no diagnostic'})"
        try:
            with open(report, encoding="utf-8") as stream:
                records = json.load(stream)
        except (OSError, json.JSONDecodeError) as exc:
            return [], f"failed (invalid JSON report: {exc})"
    findings = []
    for record in records:
        rule = record.get("RuleID") or record.get("Description") or "unknown rule"
        commit = str(record.get("Commit") or "unknown")[:12]
        path = record.get("File") or "unknown"
        line = record.get("StartLine") or "?"
        fingerprint = record.get("Fingerprint") or "not supplied"
        findings.append(Finding(
            "critical", "Gitleaks candidate", f"{commit}:{path}:{line}",
            f"rule {rule} matched (secret redacted; fingerprint {fingerprint})",
        ))
    return findings, f"completed ({len(findings)} candidate(s))"


def run_gitlint(commits: list[str]) -> tuple[list[Finding], str]:
    executable = shutil.which("gitlint")
    if not executable:
        return [], "unavailable"
    findings = []
    failures = []
    for commit in commits:
        try:
            result = subprocess.run(
                [executable, "--commit", commit, "--ignore-stdin"], text=True,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
            )
        except OSError as exc:
            return findings, f"failed to execute ({exc})"
        output_lines = [
            line.strip() for line in (result.stdout + "\n" + result.stderr).splitlines()
            if re.match(r"^\d+:\s+[A-Z]\d+\s+", line.strip())
        ]
        if result.returncode < 0 or (result.returncode and not output_lines):
            failures.append(f"{commit[:12]} exit {result.returncode}")
            continue
        for line in output_lines:
            findings.append(Finding("medium", "gitlint candidate", commit[:12], line))
    if failures:
        return findings, f"partially failed ({'; '.join(failures)})"
    return findings, f"completed ({len(findings)} candidate(s))"


def run_presidio(commits: list[str]) -> tuple[list[Finding], str]:
    try:
        from presidio_analyzer import AnalyzerEngine
        from presidio_analyzer.nlp_engine import NlpEngineProvider
        provider = NlpEngineProvider(nlp_configuration={
            "nlp_engine_name": "spacy",
            "models": [{"lang_code": "en", "model_name": "en_core_web_sm"}],
        })
        analyzer = AnalyzerEngine(
            nlp_engine=provider.create_engine(), supported_languages=["en"]
        )
    except (ImportError, OSError, RuntimeError) as exc:
        return [], f"unavailable ({type(exc).__name__}: {exc})"

    findings = []
    seen = set()
    scanned = 0
    structured_entities = [
        "CREDIT_CARD", "CRYPTO", "EMAIL_ADDRESS", "IBAN_CODE", "IP_ADDRESS",
        "PHONE_NUMBER", "US_BANK_NUMBER", "US_DRIVER_LICENSE", "US_PASSPORT",
        "US_SSN",
    ]
    prose_suffixes = (".csv", ".json", ".md", ".rst", ".text", ".txt", ".yaml", ".yml")
    for commit in commits:
        diff = git("show", "--format=", "--no-ext-diff", "--unified=0", "--find-renames", commit)
        path = "unknown"
        new_line = 0
        for line in diff.splitlines():
            if line.startswith("+++ b/"):
                path = line[6:]
            elif line.startswith("@@"):
                match = re.search(r"\+(\d+)", line)
                new_line = int(match.group(1)) if match else 0
            elif line.startswith("+") and not line.startswith("+++"):
                content = line[1:]
                scanned += 1
                try:
                    entities = structured_entities + (["PERSON"] if path.lower().endswith(prose_suffixes) else [])
                    results = analyzer.analyze(
                        text=content, language="en", entities=entities, score_threshold=0.6
                    )
                except (ValueError, RuntimeError) as exc:
                    return findings, f"partially failed after {scanned} lines ({type(exc).__name__}: {exc})"
                for result in results:
                    key = (commit, path, new_line, result.entity_type)
                    if key in seen:
                        continue
                    seen.add(key)
                    findings.append(Finding(
                        "medium", "Presidio PII candidate", f"{commit[:12]}:{path}:{new_line}",
                        f"entity {result.entity_type} matched (value redacted; confidence {result.score:.2f})",
                    ))
                new_line += 1
            elif line.startswith(" "):
                new_line += 1
    return findings, f"completed ({len(findings)} candidate(s) across {scanned} added lines)"


def review_inventory(commits: list[str]) -> tuple[list[str], list[str]]:
    messages = []
    files = set()
    for commit in commits:
        subject = git("show", "-s", "--format=%s", commit).strip()
        messages.append(f"`{commit[:12]}` — {subject}")
        for entry in git("diff-tree", "--no-commit-id", "--name-status", "-r", "-m", commit).splitlines():
            if entry:
                files.add(entry)
    return messages, sorted(files)


def inclusive_commits(start: str, end: str) -> tuple[list[str], str, str]:
    if not ref_exists(start):
        raise RuntimeError(f"start does not resolve to a commit: {start}")
    if not ref_exists(end):
        raise RuntimeError(f"end does not resolve to a commit: {end}")
    if subprocess.run(
        ["git", "merge-base", "--is-ancestor", start, end],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    ).returncode != 0:
        raise RuntimeError("start must be an ancestor of end for an inclusive range")
    start_sha = git("rev-parse", f"{start}^{{commit}}").strip()
    end_sha = git("rev-parse", f"{end}^{{commit}}").strip()
    parents = git("show", "-s", "--format=%P", start_sha).split()
    revision_args = [end_sha]
    if parents:
        revision_args.extend(["--not", *parents])
    commits = git("rev-list", "--reverse", *revision_args).splitlines()
    return commits, start_sha, end_sha


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", help="local remote-tracking ref or commit to compare with HEAD")
    parser.add_argument("--start", help="first commit to scan (inclusive; requires --end)")
    parser.add_argument("--end", help="last commit to scan (inclusive; requires --start)")
    args = parser.parse_args()
    try:
        if git("rev-parse", "--is-inside-work-tree").strip() != "true":
            raise RuntimeError("not inside a Git worktree")
        branch = git("branch", "--show-current").strip()
        if not branch and not args.start:
            raise RuntimeError("HEAD is detached")
        branch = branch or "(detached)"
        if bool(args.start) != bool(args.end):
            raise RuntimeError("--start and --end must be provided together")
        if args.base and args.start:
            raise RuntimeError("--base cannot be combined with --start and --end")

        if args.start:
            commits, start_sha, end_sha = inclusive_commits(args.start, args.end)
            range_lines = [
                f"- Start (inclusive): `{args.start}` (`{start_sha[:12]}`)",
                f"- End (inclusive): `{args.end}` (`{end_sha[:12]}`)",
            ]
            remote_line = "- Remote state: not used for the explicit inclusive range"
        else:
            base, source = resolve_base(args.base, branch)
            head = git("rev-parse", "HEAD").strip()
            base_sha = git("rev-parse", f"{base}^{{commit}}").strip()
            commits = git("rev-list", "--reverse", f"{base}..{head}").splitlines()
            range_lines = [
                f"- Base (exclusive): `{base}` (`{base_sha[:12]}`, resolved via {source})",
                f"- Head (inclusive): `{head[:12]}`",
            ]
            remote_line = "- Remote state: local cache only; no fetch performed"

        findings = scan_messages(commits)
        fallback_findings, scanned = scan_added_lines(commits)
        gitleaks_findings, gitleaks_status = run_gitleaks(commits)
        gitlint_findings, gitlint_status = run_gitlint(commits)
        presidio_findings, presidio_status = run_presidio(commits)
        findings.extend(fallback_findings)
        findings.extend(gitleaks_findings)
        findings.extend(gitlint_findings)
        findings.extend(presidio_findings)
        messages, changed_files = review_inventory(commits)
        rank = {"critical": 0, "high": 1, "medium": 2, "low": 3}
        findings.sort(key=lambda item: rank[item.severity])

        print("# Pre-push scanner evidence")
        print(f"- Branch: `{branch}`")
        print("\n".join(range_lines))
        print(f"- Commits in range: {len(commits)}")
        print(f"- Added text lines scanned: {scanned}")
        print(remote_line)
        print("\n## Tool coverage")
        print(f"- Gitleaks: {gitleaks_status}")
        print(f"- gitlint: {gitlint_status}")
        print(f"- Presidio: {presidio_status}")
        print("\n## Candidates requiring agent evaluation")
        if not findings:
            print("None.")
        else:
            for index, item in enumerate(findings, 1):
                print(f"- **C{index:03d} · {item.severity.upper()}** [{item.category}] `{item.location}` — {item.message}")
        print("\n## Commit messages for agent review")
        print("\n".join(f"- {message}" for message in messages) if messages else "None.")
        print("\n## Changed files for agent review")
        print("\n".join(f"- `{entry}`" for entry in changed_files) if changed_files else "None.")
        print("\nEvery candidate and inventory item is evidence only. Complete the LLM review described in SKILL.md.")
        return 0
    except (RuntimeError, ValueError) as exc:
        print(f"pre-push verification failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
