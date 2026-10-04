#!/usr/bin/env python3
"""Compile the repository's shared agents and skills for each installed CLI."""

from __future__ import annotations

import argparse
import json
import re
import shutil
from pathlib import Path


TARGET_PREAMBLES = {
    "claude": """## Harness compatibility

This agent is running in Claude Code. Treat references to the `Task` tool as
the `Agent` tool, and treat `subagent_type` as the requested Claude Code agent
name. Treat references to the `question` tool as `AskUserQuestion`.

""",
    "codex": """## Harness compatibility

This agent is running in Codex. Treat references to the `Task` tool as Codex
subagent delegation, and treat `subagent_type` as the requested custom-agent
name. Treat references to the `question` tool as asking the user through the
interactive input facility available in the current mode.

""",
}


def parse_agent(path: Path) -> tuple[dict[str, str], str]:
    text = path.read_text(encoding="utf-8")
    match = re.fullmatch(r"---\n(.*?)\n---\n+(.*)", text, re.DOTALL)
    if not match:
        raise ValueError(f"{path}: expected YAML frontmatter")

    metadata: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if line.startswith((" ", "\t")) or ":" not in line:
            continue
        key, value = line.split(":", 1)
        metadata[key.strip()] = value.strip()

    if not metadata.get("description"):
        raise ValueError(f"{path}: frontmatter requires description")
    return metadata, match.group(2).rstrip() + "\n"


def reset_dir(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True)


def compile_assets(source: Path, output: Path) -> None:
    agents_dir = source / "agent-files"
    skills_dir = source / "skills"
    if not agents_dir.is_dir() or not skills_dir.is_dir():
        raise ValueError(f"{source}: expected agent-files/ and skills/")

    reset_dir(output)
    for target in ("opencode/agents", "claude/agents", "codex/agents"):
        (output / target).mkdir(parents=True)

    for source_file in sorted(agents_dir.glob("*.md")):
        metadata, body = parse_agent(source_file)
        name = source_file.stem

        # OpenCode's Markdown format is the authoring format, so preserve all
        # of its permissions and mode metadata exactly.
        shutil.copy2(source_file, output / "opencode/agents" / source_file.name)

        claude = (
            "---\n"
            f"name: {name}\n"
            f"description: {json.dumps(metadata['description'])}\n"
            "---\n\n"
            f"{TARGET_PREAMBLES['claude']}{body}"
        )
        (output / "claude/agents" / source_file.name).write_text(
            claude, encoding="utf-8"
        )

        codex = (
            f"name = {json.dumps(name)}\n"
            f"description = {json.dumps(metadata['description'])}\n"
            "developer_instructions = "
            f"{json.dumps(TARGET_PREAMBLES['codex'] + body)}\n"
        )
        (output / "codex/agents" / f"{name}.toml").write_text(
            codex, encoding="utf-8"
        )

    shutil.copytree(skills_dir, output / "skills")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    compile_assets(args.source, args.output)


if __name__ == "__main__":
    main()
