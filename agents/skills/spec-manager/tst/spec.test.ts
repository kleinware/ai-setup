import { describe, it, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SKILL_DIR = join(import.meta.dir, "..");
const SCRIPT = join(SKILL_DIR, "spec.ts");
const FIXTURES = join(import.meta.dir, "fixtures");

function run(fix: string | null, args: string[]): { code: number; out: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "spec-tst-"));
  if (fix) cpSync(join(FIXTURES, fix), dir, { recursive: true });
  try {
    const out = execFileSync("bun", [SCRIPT, "--spec-dir", dir, ...args], { encoding: "utf-8" });
    return { code: 0, out: out as string, dir };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    return { code: err.status ?? 1, out, dir };
  }
}

type Case = {
  name: string;
  fix: string | null;
  args: string[];
  expectCode: number;
  expectContains: string[];
  expectFile?: { name: string; contains: string[]; notContains?: string[] };
};

const cases: Case[] = [
  {
    name: "read existing spec",
    fix: "h-read",
    args: ["read", "--id", "a_b_c_one"],
    expectCode: 0,
    expectContains: ["action=read", "a_b_c_one", "first spec"],
  },
  {
    name: "write creates new spec in a new leaf file",
    fix: "h-write-create",
    args: ["write", "--id", "a_b_d_two", "--description", "second spec", "--motivation", "because", "--acceptance-criteria", "ok", "--status", "pending"],
    expectCode: 0,
    expectContains: ["action=create", "a_b_d_two", "path=a_b_d.spec.md"],
  },
  {
    name: "write appends to a leaf file with a blank line between specs",
    fix: "h-write-append",
    args: ["write", "--id", "a_b_c_three", "--description", "third spec", "--motivation", "because", "--acceptance-criteria", "ok", "--status", "pending"],
    expectCode: 0,
    expectContains: ["action=create", "a_b_c_three", "path=a_b_c.spec.md"],
    expectFile: {
      name: "a_b_c.spec.md",
      contains: ["\n\n  - id: a_b_c_two", "\n\n  - id: a_b_c_three"],
    },
  },
  {
    name: "write updates existing spec",
    fix: "h-write-update",
    args: ["write", "--id", "a_b_c_one", "--description", "first spec v2", "--motivation", "because", "--acceptance-criteria", "ok", "--status", "done"],
    expectCode: 0,
    expectContains: ["action=update", "a_b_c_one", "path=a_b_c.spec.md"],
  },
  {
    name: "find returns matches across leaf files",
    fix: "h-find",
    args: ["find", "--query", "search"],
    expectCode: 0,
    expectContains: ["count=1", "a_b_c_one"],
  },
  {
    name: "validate passes on valid store",
    fix: "h-validate-ok",
    args: ["validate"],
    expectCode: 0,
    expectContains: ["status=success", "has-status=true", "taxonomy=checked"],
  },
  {
    name: "validate passes with no config (defaults)",
    fix: "h-noconfig",
    args: ["validate"],
    expectCode: 0,
    expectContains: ["has-status=false", "taxonomy=skipped"],
  },
  {
    name: "validate passes with layers false",
    fix: "h-layers-false",
    args: ["validate"],
    expectCode: 0,
    expectContains: ["status=success", "has-status=false", "taxonomy=skipped"],
  },
  {
    name: "write creates flat spec when layers false",
    fix: "h-layers-false",
    args: ["write", "--id", "flat-two", "--description", "second flat spec", "--motivation", "because", "--acceptance-criteria", "ok"],
    expectCode: 0,
    expectContains: ["action=create", "flat-two", "path=specs.spec.md"],
  },
  {
    name: "write with layered id fails when layers false",
    fix: "h-layers-false",
    args: ["write", "--id", "a_b_c_one", "--description", "d", "--motivation", "m", "--acceptance-criteria", "ok"],
    expectCode: 1,
    expectContains: ["reason=invalid-id"],
  },
  {
    name: "read missing id fails",
    fix: "s-read-missing",
    args: ["read", "--id", "a_b_c_missing"],
    expectCode: 1,
    expectContains: ["reason=not-found"],
  },
  {
    name: "write without --status when enabled fails",
    fix: "s-write-no-status",
    args: ["write", "--id", "a_b_d_x", "--description", "d", "--motivation", "m", "--acceptance-criteria", "ok"],
    expectCode: 1,
    expectContains: ["reason=status-invalid"],
  },
  {
    name: "write with unknown state fails",
    fix: "s-write-bad-state",
    args: ["write", "--id", "a_b_d_x", "--description", "d", "--motivation", "m", "--acceptance-criteria", "ok", "--status", "bogus"],
    expectCode: 1,
    expectContains: ["reason=status-invalid"],
  },
  {
    name: "write with malformed id fails",
    fix: "s-write-bad-id",
    args: ["write", "--id", "a_b", "--description", "d", "--motivation", "m", "--acceptance-criteria", "ok", "--status", "pending"],
    expectCode: 1,
    expectContains: ["reason=invalid-id"],
  },
  {
    name: "write with unknown taxonomy term fails",
    fix: "s-write-unknown-tax",
    args: ["write", "--id", "a_b_zz_x", "--description", "d", "--motivation", "m", "--acceptance-criteria", "ok", "--status", "pending"],
    expectCode: 1,
    expectContains: ["reason=taxonomy-unknown"],
  },
  {
    name: "validate fails on duplicate id",
    fix: "s-validate-dup",
    args: ["validate"],
    expectCode: 1,
    expectContains: ["reason=validate-failed", "duplicate id"],
  },
  {
    name: "validate fails on uncovered taxonomy term",
    fix: "s-validate-coverage",
    args: ["validate"],
    expectCode: 1,
    expectContains: ["reason=validate-failed", "has no specs"],
  },
  {
    name: "validate fails on invalid config (uppercase state)",
    fix: "s-config-uppercase",
    args: ["validate"],
    expectCode: 1,
    expectContains: ["reason=config-invalid"],
  },
  {
    name: "validate fails on invalid config (depth mismatch)",
    fix: "s-config-depth",
    args: ["validate"],
    expectCode: 1,
    expectContains: ["reason=config-invalid"],
  },
  {
    name: "validate fails on invalid config (layers false with structure)",
    fix: "s-layers-false-structure",
    args: ["validate"],
    expectCode: 1,
    expectContains: ["reason=config-invalid", "must be omitted"],
  },
  {
    name: "validate fails on invalid config (layers list without structure)",
    fix: "s-layers-no-structure",
    args: ["validate"],
    expectCode: 1,
    expectContains: ["reason=config-invalid", "structure is required"],
  },
  {
    name: "validate fails on status key when status disabled",
    fix: "s-status-disabled-key",
    args: ["validate"],
    expectCode: 1,
    expectContains: ["reason=validate-failed", "status is not allowed"],
  },
  {
    name: "validate fails when spec file is missing",
    fix: "s-spec-missing",
    args: ["validate"],
    expectCode: 1,
    expectContains: ["reason=spec-file-missing"],
  },
  {
    name: "validate fails on legacy single-file store",
    fix: "s-legacy-store",
    args: ["validate"],
    expectCode: 1,
    expectContains: ["reason=legacy-store"],
  },
  {
    name: "validate fails when a spec is in the wrong leaf file",
    fix: "s-wrong-file",
    args: ["validate"],
    expectCode: 1,
    expectContains: ["reason=validate-failed", "belongs in 'a_b_c.spec.md'"],
  },
  {
    name: "validate fails on malformed store",
    fix: "s-malformed-store",
    args: ["validate"],
    expectCode: 1,
    expectContains: ["reason=malformed-store"],
  },
   {
     name: "find with no matches succeeds with count=0",
     fix: "s-find-none",
     args: ["find", "--query", "zzz"],
     expectCode: 0,
     expectContains: ["count=0"],
   },
   {
     name: "config get prints the config file",
     fix: "h-config",
     args: ["config", "get"],
     expectCode: 0,
     expectContains: ["action=config-get", "path=spec/.config.yaml", "pending", "done", "structure:"],
   },
   {
     name: "config get reports a missing config",
     fix: "h-noconfig",
     args: ["config", "get"],
     expectCode: 0,
     expectContains: ["action=config-get", "file=missing"],
   },
   {
     name: "config get fails on a broken config",
     fix: "s-config-uppercase",
     args: ["config", "get"],
     expectCode: 1,
     expectContains: ["reason=config-invalid"],
   },
   {
     name: "config set creates a config from scratch",
     fix: null,
     args: ["config", "set", "--status", "pending", "done", "--layers", "a", "b", "c", "--structure", "a: {b: [c, d]}"],
     expectCode: 0,
     expectContains: ["action=config-set", "path=spec/.config.yaml"],
     expectFile: {
       name: ".config.yaml",
       contains: ["status:", "pending", "done", "layers:", "structure:", "- c", "- d"],
     },
   },
   {
     name: "config set updates only the status and keeps the taxonomy",
     fix: "h-config",
     args: ["config", "set", "--status", "wip:in progress", "done:finished"],
     expectCode: 0,
     expectContains: ["action=config-set"],
     expectFile: {
       name: ".config.yaml",
       contains: ["state: wip", "description: in progress", "state: done", "structure:"],
     },
   },
   {
     name: "config set disables status",
     fix: "h-config",
     args: ["config", "set", "--status", "false"],
     expectCode: 0,
     expectContains: ["action=config-set"],
     expectFile: { name: ".config.yaml", contains: ["status: false", "structure:"] },
   },
   {
     name: "config set disables layers and drops the structure",
     fix: "h-config",
     args: ["config", "set", "--layers", "false"],
     expectCode: 0,
     expectContains: ["action=config-set"],
     expectFile: {
       name: ".config.yaml",
       contains: ["layers: false", "status:"],
       notContains: ["structure"],
     },
   },
   {
     name: "config set rejects layers false together with a structure",
     fix: "h-config",
     args: ["config", "set", "--layers", "false", "--structure", "a: [b]"],
     expectCode: 1,
     expectContains: ["reason=config-invalid", "must be omitted"],
   },
   {
     name: "config set rejects a structure whose depth does not match the layers",
     fix: "h-config",
     args: ["config", "set", "--layers", "a", "b", "--structure", "a: {b: [c]}"],
     expectCode: 1,
     expectContains: ["reason=config-invalid"],
   },
   {
     name: "config set rejects an invalid state name",
     fix: "h-config",
     args: ["config", "set", "--status", "Pending"],
     expectCode: 1,
     expectContains: ["reason=config-invalid"],
   },
   {
     name: "config set rejects a non-mapping structure",
     fix: "h-config",
     args: ["config", "set", "--structure", "a"],
     expectCode: 1,
     expectContains: ["reason=config-invalid", "must be a YAML mapping"],
   },
   {
     name: "config set fails without any flag",
     fix: "h-config",
     args: ["config", "set"],
     expectCode: 2,
     expectContains: [],
   },
   {
     name: "config set can fix a broken config",
     fix: "s-config-depth",
     args: ["config", "set", "--structure", "a: {b: [c]}"],
     expectCode: 0,
     expectContains: ["action=config-set"],
     expectFile: { name: ".config.yaml", contains: ["structure:", "- c"] },
   },
   {
     name: "config set still fails when the result stays invalid",
     fix: "s-config-depth",
     args: ["config", "set", "--status", "wip:in progress"],
     expectCode: 1,
     expectContains: ["reason=config-invalid"],
   },
   {
     name: "config add appends a term to a leaf list",
     fix: "h-config",
     args: ["config", "add", "--term", "e", "--parent", "a/b"],
     expectCode: 0,
     expectContains: ["action=config-add", "term=e"],
     expectFile: { name: ".config.yaml", contains: ["- e"] },
   },
   {
     name: "config add rejects an existing term",
     fix: "h-config",
     args: ["config", "add", "--term", "c", "--parent", "a/b"],
     expectCode: 1,
     expectContains: ["reason=term-exists"],
   },
   {
     name: "config add rejects an unknown parent",
     fix: "h-config",
     args: ["config", "add", "--term", "e", "--parent", "a/z"],
     expectCode: 1,
     expectContains: ["reason=term-not-found"],
   },
   {
     name: "config add rejects a parent that is not a leaf level",
     fix: "h-config",
     args: ["config", "add", "--term", "e", "--parent", "a"],
     expectCode: 1,
     expectContains: ["reason=term-not-found"],
   },
   {
     name: "config add fails when the config is missing",
     fix: "h-noconfig",
     args: ["config", "add", "--term", "e", "--parent", "a/b"],
     expectCode: 1,
     expectContains: ["reason=config-missing"],
   },
   {
     name: "config add fails when layers is false",
     fix: "h-layers-false",
     args: ["config", "add", "--term", "x"],
     expectCode: 1,
     expectContains: ["reason=config-invalid"],
   },
   {
     name: "config remove drops a term from a leaf list",
     fix: "h-config",
     args: ["config", "remove", "--term", "d", "--parent", "a/b"],
     expectCode: 0,
     expectContains: ["action=config-remove", "term=d"],
     expectFile: {
       name: ".config.yaml",
       contains: ["- c\n"],
       notContains: ["- d\n"],
     },
   },
   {
     name: "config remove rejects a missing term",
     fix: "h-config",
     args: ["config", "remove", "--term", "zz", "--parent", "a/b"],
     expectCode: 1,
     expectContains: ["reason=term-not-found"],
   },
   {
     name: "config remove fails when it would empty the structure",
     fix: "h-config-min",
     args: ["config", "remove", "--term", "b", "--parent", "a"],
     expectCode: 1,
     expectContains: ["reason=config-invalid"],
   },
   {
     name: "config remove fails when the config is missing",
     fix: "h-noconfig",
     args: ["config", "remove", "--term", "b", "--parent", "a"],
     expectCode: 1,
     expectContains: ["reason=config-missing"],
   },
 ];

describe("spec-manager CLI", () => {
  for (const c of cases) {
    it(c.name, () => {
      const { code, out, dir } = run(c.fix, c.args);
      try {
        expect(code).toBe(c.expectCode);
        for (const s of c.expectContains) {
          expect(out).toContain(s);
        }
        if (c.expectFile) {
          const content = readFileSync(join(dir, c.expectFile.name), "utf8");
          for (const s of c.expectFile.contains) {
            expect(content).toContain(s);
          }
          for (const s of c.expectFile.notContains ?? []) {
            expect(content).not.toContain(s);
          }
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
