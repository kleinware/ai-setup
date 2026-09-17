#!/usr/bin/env python3
"""Manage spec entries stored as YAML in spec/SPECS.md at the repo root.

Usage:
  spec.py read  --id <id>
  spec.py write --id <id> --description <text> --motivation <text> \
      --acceptance-criteria <criterion> [<criterion> ...]
  spec.py find  --query <string>

stdout contract:
  First line is always a single key=value status line.
  read: the spec YAML follows after a blank line.
  find: a YAML list of id/description mappings follows after a blank line.
Exit codes: 0 success, 1 failure, 2 usage error.
"""

import argparse
import os
import re
import subprocess
import sys
import tempfile

import yaml

SPEC_FILE = os.path.join("spec", "SPECS.md")
ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*(_[a-z0-9]+(?:-[a-z0-9]+)*){3}$")


def kv(value):
    value = str(value)
    if re.search(r"\s", value):
        return '"' + value.replace('"', '\\"') + '"'
    return value


def fail(reason, extra=None, block=None):
    line = "status=failed reason=" + reason
    if extra:
        line += " " + " ".join("{}={}".format(k, kv(v)) for k, v in extra.items())
    print(line)
    if block is not None:
        print(block[0] + ":")
        for entry in block[1]:
            print(entry)
    sys.exit(1)


def err_line(exc):
    return " ".join(str(exc).split())


def repo_root(cwd):
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            check=True,
        )
        return proc.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError, OSError):
        return cwd


def parse_taxonomy(agents_path):
    """Parse '## Spec taxonomy' bullets from AGENTS.md.

    Returns {'area': set, 'component': set, 'section': set} or None.
    """
    try:
        with open(agents_path, encoding="utf-8") as f:
            lines = f.read().splitlines()
    except OSError:
        return None
    start = None
    for i, line in enumerate(lines):
        m = re.match(r"^(#{1,6})\s*(.+?)\s*$", line)
        if m and "spec taxonomy" in m.group(2).lower():
            start = i
            break
    if start is None:
        return None
    end = len(lines)
    for j in range(start + 1, len(lines)):
        if re.match(r"^(#{1,6})\s", lines[j]):
            end = j
            break
    key_map = {"areas": "area", "components": "component", "sections": "section"}
    taxonomy = {}
    for line in lines[start + 1:end]:
        m = re.match(r"^\s*-\s*([A-Za-z]+)\s*:\s*(.*)$", line)
        if not m or m.group(1).lower() not in key_map:
            continue
        values = [v.strip().strip("`").strip() for v in m.group(2).split(",")]
        taxonomy[key_map[m.group(1).lower()]] = set(v for v in values if v)
    return taxonomy or None


def load_store(path):
    """Return (specs, error, detail)."""
    if not os.path.exists(path):
        return None, "spec-file-missing", None
    try:
        with open(path, encoding="utf-8") as f:
            data = yaml.safe_load(f)
    except (yaml.YAMLError, UnicodeDecodeError) as exc:
        return None, "yaml-error", err_line(exc)
    if not isinstance(data, dict) or not isinstance(data.get("specs"), list):
        return None, "malformed-store", None
    for item in data["specs"]:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            return None, "malformed-store", None
    return data["specs"], None, None


def write_store(path, specs):
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".SPECS.md.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(
                yaml.safe_dump(
                    {"specs": specs},
                    sort_keys=False,
                    width=100,
                    default_flow_style=False,
                )
            )
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def spec_text(spec):
    parts = [
        str(spec.get("id", "")),
        str(spec.get("description", "")),
        str(spec.get("motivation", "")),
    ]
    ac = spec.get("acceptance_criteria")
    if isinstance(ac, list):
        parts.extend(str(x) for x in ac)
    else:
        parts.append(str(ac or ""))
    return "\n".join(parts)


def do_read(args, spec_path):
    if not ID_RE.match(args.id):
        fail("invalid-id", {"id": args.id, "pattern": "{area}_{component}_{section}_{result}"})
    specs, err, detail = load_store(spec_path)
    if err:
        extra = {"id": args.id, "file": SPEC_FILE}
        if detail:
            extra["error"] = detail
        fail(err, extra)
    for spec in specs:
        if spec.get("id") == args.id:
            print("status=success action=read id=" + args.id)
            print()
            print(
                yaml.safe_dump(spec, sort_keys=False, width=100, default_flow_style=False)
            )
            return 0
    known = ",".join(str(s.get("id")) for s in specs)
    fail("not-found", {"id": args.id, "known": known})


def do_write(args, spec_path, agents_path):
    if not ID_RE.match(args.id):
        fail("invalid-id", {"id": args.id, "pattern": "{area}_{component}_{section}_{result}"})
    problems = []
    if not isinstance(args.description, str) or not args.description.strip():
        problems.append("--description must be a non-empty string")
    if not isinstance(args.motivation, str) or not args.motivation.strip():
        problems.append("--motivation must be a non-empty string")
    criteria = args.acceptance_criteria
    if not criteria or not all(isinstance(c, str) and c.strip() for c in criteria):
        problems.append("--acceptance-criteria must be one or more non-empty strings")
    if problems:
        fail("schema-invalid", {"id": args.id}, ("problems", problems))
    spec = {
        "id": args.id,
        "description": args.description,
        "motivation": args.motivation,
        "acceptance_criteria": list(criteria),
    }
    taxonomy = parse_taxonomy(agents_path)
    if taxonomy:
        parts = args.id.split("_")
        tprobs = []
        for name, idx in (("area", 0), ("component", 1), ("section", 2)):
            allowed = taxonomy.get(name)
            if allowed and parts[idx] not in allowed:
                tprobs.append(
                    "{} '{}' is not declared in the AGENTS.md spec taxonomy".format(name, parts[idx])
                )
        if tprobs:
            fail("taxonomy-unknown", {"id": args.id}, ("problems", tprobs))
    specs, err, detail = load_store(spec_path)
    if err and err != "spec-file-missing":
        extra = {"file": SPEC_FILE}
        if detail:
            extra["error"] = detail
        fail(err, extra)
    if specs is None:
        specs = []
    action = "update" if any(s.get("id") == args.id for s in specs) else "create"
    specs = [s for s in specs if s.get("id") != args.id]
    specs.append(spec)
    specs.sort(key=lambda s: str(s.get("id")))
    try:
        write_store(spec_path, specs)
    except OSError as exc:
        fail("io-error", {"file": SPEC_FILE, "error": err_line(exc)})
    print(
        "status=success action={} id={} path={} taxonomy={}".format(
            action,
            args.id,
            SPEC_FILE,
            "checked" if taxonomy else "skipped",
        )
    )
    return 0


def do_find(args, spec_path):
    query = args.query.lower()
    specs, err, detail = load_store(spec_path)
    if err and err != "spec-file-missing":
        extra = {"file": SPEC_FILE}
        if detail:
            extra["error"] = detail
        fail(err, extra)
    if specs is None:
        specs = []
    matches = [
        {"id": s.get("id"), "description": s.get("description")}
        for s in specs
        if query in spec_text(s).lower()
    ]
    print("status=success action=find query={} count={}".format(kv(args.query), len(matches)))
    print()
    print(yaml.safe_dump(matches, sort_keys=False, width=100, default_flow_style=False))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog="spec.py")
    sub = parser.add_subparsers(dest="action", required=True)
    p_read = sub.add_parser("read", help="print one spec by id")
    p_read.add_argument("--id", required=True)
    p_write = sub.add_parser("write", help="create or update a spec from CLI arguments")
    p_write.add_argument("--id", required=True)
    p_write.add_argument("--description", required=True)
    p_write.add_argument("--motivation", required=True)
    p_write.add_argument(
        "--acceptance-criteria",
        required=True,
        nargs="+",
        help="one or more acceptance criteria",
    )
    p_find = sub.add_parser("find", help="find specs containing a query string")
    p_find.add_argument("--query", required=True)
    args = parser.parse_args(argv)

    root = repo_root(os.getcwd())
    spec_path = os.path.join(root, SPEC_FILE)
    agents_path = os.path.join(root, "AGENTS.md")

    if args.action == "read":
        return do_read(args, spec_path)
    if args.action == "write":
        return do_write(args, spec_path, agents_path)
    return do_find(args, spec_path)


if __name__ == "__main__":
    sys.exit(main())
