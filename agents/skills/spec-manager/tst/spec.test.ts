import { describe, it, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

const SKILL_DIR = join(import.meta.dir, "..");
const SCRIPT = join(SKILL_DIR, "spec.ts");
const FIXTURES = join(import.meta.dir, "fixtures");

function freshDir(fix: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "spec-tst-"));
  if (fix) cpSync(join(FIXTURES, fix), dir, { recursive: true });
  return dir;
}

function runIn(dir: string, args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync("bun", [SCRIPT, "--spec-dir", dir, ...args], { encoding: "utf-8" });
    return { code: 0, out: out as string };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    return { code: err.status ?? 1, out };
  }
}

function run(fix: string | null, args: string[]): { code: number; out: string; dir: string } {
  const dir = freshDir(fix);
  const { code, out } = runIn(dir, args);
  return { code, out, dir };
}

type Case = {
  name: string;
  fix: string | null;
  args: string[];
  expectCode: number;
  expectContains: string[];
  expectNotContains?: string[];
  expectFile?: { name: string; contains: string[]; notContains?: string[] };
  expectFileMissing?: string;
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
    expectContains: ["action=create", "a_b_d_two", "path=a_b_d.spec.yaml"],
  },
  {
    name: "write appends to a leaf file with a blank line between specs",
    fix: "h-write-append",
    args: ["write", "--id", "a_b_c_three", "--description", "third spec", "--motivation", "because", "--acceptance-criteria", "ok", "--status", "pending"],
    expectCode: 0,
    expectContains: ["action=create", "a_b_c_three", "path=a_b_c.spec.yaml"],
    expectFile: {
      name: "a_b_c.spec.yaml",
      contains: ["\n\n  - id: a_b_c_two", "\n\n  - id: a_b_c_three"],
    },
  },
    {
      name: "write updates existing spec",
      fix: "h-write-update",
      args: ["write", "--id", "a_b_c_one", "--description", "first spec v2", "--motivation", "because", "--acceptance-criteria", "ok", "--status", "done"],
      expectCode: 0,
      expectContains: ["action=update", "a_b_c_one", "path=a_b_c.spec.yaml"],
    },
    {
      name: "delete removes a spec from a leaf file",
      fix: "h-write-append",
      args: ["delete", "--id", "a_b_c_two"],
      expectCode: 0,
      expectContains: ["action=delete", "a_b_c_two", "path=a_b_c.spec.yaml"],
      expectFile: {
        name: "a_b_c.spec.yaml",
        contains: ["a_b_c_one"],
        notContains: ["a_b_c_two"],
      },
    },
    {
      name: "delete removes the last spec and deletes the leaf file",
      fix: "h-read",
      args: ["delete", "--id", "a_b_c_one"],
      expectCode: 0,
      expectContains: ["action=delete", "a_b_c_one", "path=a_b_c.spec.yaml"],
      expectFileMissing: "a_b_c.spec.yaml",
    },
    {
      name: "delete removes a spec from the flat file",
      fix: "h-delete-flat",
      args: ["delete", "--id", "flat-two"],
      expectCode: 0,
      expectContains: ["action=delete", "flat-two", "path=specs.spec.yaml"],
      expectFile: {
        name: "specs.spec.yaml",
        contains: ["flat-one"],
        notContains: ["flat-two"],
      },
    },
    {
      name: "delete removes the last flat spec and deletes the file",
      fix: "h-flat",
      args: ["delete", "--id", "flat-one"],
      expectCode: 0,
      expectContains: ["action=delete", "flat-one", "path=specs.spec.yaml"],
      expectFileMissing: "specs.spec.yaml",
    },
    {
      name: "delete of a missing id fails",
      fix: "s-read-missing",
      args: ["delete", "--id", "a_b_c_missing"],
      expectCode: 1,
      expectContains: ["reason=not-found"],
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
    expectContains: ["action=create", "flat-two", "path=specs.spec.yaml"],
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
    expectContains: ["reason=validate-failed", "belongs in 'a_b_c.spec.yaml'"],
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
      name: "query config prints the normalized config",
      fix: "h-query",
      args: ["query", "config"],
      expectCode: 0,
      expectContains: ["action=query-config", "status:", "pending", "done", "layers:", "area", "structure:", "interface", "tui"],
    },
    {
      name: "query config reports a missing config",
      fix: "h-noconfig",
      args: ["query", "config"],
      expectCode: 0,
      expectContains: ["action=query-config", "file=missing"],
    },
    {
      name: "query config fails on a broken config",
      fix: "s-config-uppercase",
      args: ["query", "config"],
      expectCode: 1,
      expectContains: ["reason=config-invalid"],
    },
    {
      name: "query config normalizes layers false",
      fix: "h-flat",
      args: ["query", "config"],
      expectCode: 0,
      expectContains: ["action=query-config", "layers: false"],
    },
    {
      name: "query tasks by status",
      fix: "h-query",
      args: ["query", "tasks", "--status", "pending"],
      expectCode: 0,
      expectContains: ["action=query-tasks", "status=pending", "count=2", "interface_tui_results_error-surfaced", "interface_tui_errors_crash-reported"],
    },
    {
      name: "query tasks by status and layer",
      fix: "h-query",
      args: ["query", "tasks", "--status", "done", "--layer", "interface/tui"],
      expectCode: 0,
      expectContains: ["action=query-tasks", "status=done", "layer=interface/tui", "count=1", "interface_tui_results_presented-info"],
    },
    {
      name: "query tasks by layer prefix",
      fix: "h-query",
      args: ["query", "tasks", "--layer", "interface"],
      expectCode: 0,
      expectContains: ["layer=interface", "count=3"],
    },
    {
      name: "query tasks with multiple layer paths",
      fix: "h-query",
      args: ["query", "tasks", "--layer", "interface/tui/results", "--layer", "agents"],
      expectCode: 0,
      expectContains: ["layer=interface/tui/results", "layer=agents", "count=3"],
    },
    {
      name: "query tasks by status with layers false",
      fix: "h-flat",
      args: ["query", "tasks", "--status", "pending"],
      expectCode: 0,
      expectContains: ["count=1", "flat-one"],
    },
    {
      name: "query tasks with no filter fails",
      fix: "h-query",
      args: ["query", "tasks"],
      expectCode: 2,
      expectContains: [],
    },
    {
      name: "query tasks with an unknown state fails",
      fix: "h-query",
      args: ["query", "tasks", "--status", "bogus"],
      expectCode: 1,
      expectContains: ["reason=status-invalid"],
    },
    {
      name: "query tasks with --status when status is disabled fails",
      fix: "h-noconfig",
      args: ["query", "tasks", "--status", "done"],
      expectCode: 1,
      expectContains: ["reason=status-invalid"],
    },
    {
      name: "query tasks with --layer when layers is false fails",
      fix: "h-flat",
      args: ["query", "tasks", "--layer", "a"],
      expectCode: 1,
      expectContains: ["reason=layer-invalid"],
    },
    {
      name: "query tasks with an unknown layer term fails",
      fix: "h-query",
      args: ["query", "tasks", "--layer", "interface/unknown"],
      expectCode: 1,
      expectContains: ["reason=taxonomy-unknown"],
    },
    {
      name: "query tasks with a too-long layer path fails",
      fix: "h-query",
      args: ["query", "tasks", "--layer", "interface/tui/results/errors"],
      expectCode: 1,
      expectContains: ["reason=layer-invalid"],
    },
    {
      name: "write stores an arbitrary meta value after status",
      fix: "h-write-create",
      args: ["write", "--id", "a_b_c_meta", "--description", "spec with meta", "--motivation", "because", "--acceptance-criteria", "ok", "--status", "pending", "--meta", "owner: matt\nticket: 42"],
      expectCode: 0,
      expectContains: ["action=create", "a_b_c_meta", "path=a_b_c.spec.yaml"],
      expectFile: {
        name: "a_b_c.spec.yaml",
        contains: ["status: pending\n    meta:", "owner: matt", "ticket: 42"],
      },
    },
    {
      name: "read returns the meta field",
      fix: "h-meta",
      args: ["read", "--id", "a_b_c_one"],
      expectCode: 0,
      expectContains: ["action=read", "a_b_c_one", "owner: matt", "ticket: 42"],
    },
    {
      name: "find matches on meta content and returns it",
      fix: "h-meta",
      args: ["find", "--query", "ticket"],
      expectCode: 0,
      expectContains: ["count=1", "a_b_c_one", "owner: matt", "ticket: 42"],
    },
    {
      name: "query tasks returns the meta field",
      fix: "h-meta",
      args: ["query", "tasks", "--status", "done"],
      expectCode: 0,
      expectContains: ["count=1", "a_b_c_one", "owner: matt"],
    },
    {
      name: "validate passes when a spec carries meta",
      fix: "h-meta",
      args: ["validate"],
      expectCode: 0,
      expectContains: ["status=success"],
    },
    {
      name: "write with a null meta fails",
      fix: "h-meta",
      args: ["write", "--id", "a_b_c_meta", "--description", "d", "--motivation", "m", "--acceptance-criteria", "ok", "--status", "pending", "--meta", "~"],
      expectCode: 1,
      expectContains: ["reason=schema-invalid", "must be a non-null YAML value"],
    },
    {
      name: "write with malformed meta yaml fails",
      fix: "h-meta",
      args: ["write", "--id", "a_b_c_meta", "--description", "d", "--motivation", "m", "--acceptance-criteria", "ok", "--status", "pending", "--meta", "owner: [bad"],
      expectCode: 1,
      expectContains: ["reason=yaml-error"],
    },
    {
      name: "validate fails on a null meta in the store",
      fix: "s-meta-null",
      args: ["validate"],
      expectCode: 1,
      expectContains: ["reason=validate-failed", "meta must not be null"],
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
      args: ["config", "set", "--status", "pending:not started", "done:finished", "--layers", "a", "b", "c", "--structure", "a: {b: [c, d]}"],
      expectCode: 0,
      expectContains: ["action=config-set", "path=spec/.config.yaml"],
      expectFile: {
        name: ".config.yaml",
        contains: ["status:", "name: pending", "name: done", "description: not started", "layers:", "structure:", "- c", "- d"],
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
        contains: ["name: wip", "description: in progress", "name: done", "structure:"],
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
      args: ["config", "set", "--status", "Pending:capitalized"],
      expectCode: 1,
      expectContains: ["reason=config-invalid"],
    },
    {
      name: "config set rejects a status entry without a description",
      fix: "h-config",
      args: ["config", "set", "--status", "pending"],
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
    {
      name: "[query-change-output] read prints the meta.change object",
      fix: "h-change-output",
      args: ["read", "--id", "a_b_c_one"],
      expectCode: 0,
      expectContains: [
        "action=read",
        "change:",
        "change_status: pending",
        "updated description",
        "updated motivation",
        "revised criterion",
        "appended criterion",
      ],
    },
    {
      name: "[query-change-output] read omits meta.history by default",
      fix: "h-change-output",
      args: ["read", "--id", "a_b_c_one"],
      expectCode: 0,
      expectContains: ["a_b_c_one", "notes: keep me"],
      expectNotContains: ["history"],
    },
    {
      name: "[query-change-output] read --include-history includes meta.history",
      fix: "h-change-output",
      args: ["read", "--id", "a_b_c_one", "--include-history"],
      expectCode: 0,
      expectContains: ["history:", "applied 2026-01-01", "notes: keep me"],
    },
    {
      name: "[query-change-output] find omits meta.history by default",
      fix: "h-change-output",
      args: ["find", "--query", "revised"],
      expectCode: 0,
      expectContains: ["count=1", "a_b_c_one", "change:", "notes: keep me"],
      expectNotContains: ["history"],
    },
    {
      name: "[query-change-output] find --include-history includes meta.history",
      fix: "h-change-output",
      args: ["find", "--query", "revised", "--include-history"],
      expectCode: 0,
      expectContains: ["history:", "applied 2026-01-01"],
    },
    {
      name: "[query-change-output] query tasks omits meta.history by default",
      fix: "h-change-output",
      args: ["query", "tasks", "--status", "done"],
      expectCode: 0,
      expectContains: ["action=query-tasks", "count=1", "a_b_c_one", "change:", "notes: keep me"],
      expectNotContains: ["history"],
    },
    {
      name: "[query-change-output] query tasks --include-history includes meta.history",
      fix: "h-change-output",
      args: ["query", "tasks", "--status", "done", "--include-history"],
      expectCode: 0,
      expectContains: ["history:", "applied 2026-01-01", "notes: keep me"],
    },
    {
      name: "[meta-change-schema] change object with a non-allowed key fails",
      fix: "h-write-create",
      args: [
        "write", "--id", "a_b_c_x", "--description", "d", "--motivation", "m",
        "--acceptance-criteria", "ok", "--status", "pending",
        "--meta", "change: {change_status: pending, notes: extra}",
      ],
      expectCode: 1,
      expectContains: ["reason=schema-invalid", "meta.change"],
    },
    {
      name: "[meta-change-validation] write fails when change contains an id key",
      fix: "h-write-create",
      args: [
        "write", "--id", "a_b_c_x", "--description", "d", "--motivation", "m",
        "--acceptance-criteria", "ok", "--status", "pending",
        "--meta", "change: {change_status: pending, id: oops}",
      ],
      expectCode: 1,
      expectContains: ["reason=schema-invalid", "meta.change"],
    },
    {
      name: "[meta-change-validation] write fails when change contains a status key",
      fix: "h-write-create",
      args: [
        "write", "--id", "a_b_c_x", "--description", "d", "--motivation", "m",
        "--acceptance-criteria", "ok", "--status", "pending",
        "--meta", "change: {change_status: pending, status: done}",
      ],
      expectCode: 1,
      expectContains: ["reason=schema-invalid", "meta.change"],
    },
    {
      name: "[meta-change-validation] write fails when change contains a meta key",
      fix: "h-write-create",
      args: [
        "write", "--id", "a_b_c_x", "--description", "d", "--motivation", "m",
        "--acceptance-criteria", "ok", "--status", "pending",
        "--meta", "change: {change_status: pending, meta: {note: x}}",
      ],
      expectCode: 1,
      expectContains: ["reason=schema-invalid", "meta.change"],
    },
    {
      name: "[meta-change-validation] write fails when change_status is not pending or approved",
      fix: "h-write-create",
      args: [
        "write", "--id", "a_b_c_x", "--description", "d", "--motivation", "m",
        "--acceptance-criteria", "ok", "--status", "pending",
        "--meta", "change: {change_status: merged}",
      ],
      expectCode: 1,
      expectContains: ["reason=schema-invalid", "change_status"],
    },
    {
      name: "[meta-change-validation] write fails when change_status is missing",
      fix: "h-write-create",
      args: [
        "write", "--id", "a_b_c_x", "--description", "d", "--motivation", "m",
        "--acceptance-criteria", "ok", "--status", "pending",
        "--meta", "change: {description: changed}",
      ],
      expectCode: 1,
      expectContains: ["reason=schema-invalid", "change_status"],
    },
    {
      name: "[meta-change-validation] write fails when a numeric index key maps to a number",
      fix: "h-write-create",
      args: [
        "write", "--id", "a_b_c_x", "--description", "d", "--motivation", "m",
        "--acceptance-criteria", "ok", "--status", "pending",
        "--meta", "change: {change_status: pending, acceptance_criteria: {\"0\": 42}}",
      ],
      expectCode: 1,
      expectContains: ["reason=schema-invalid", "acceptance_criteria"],
    },
    {
      name: "[meta-change-validation] validate flags a spec whose meta.change is invalid",
      fix: "s-change-invalid",
      args: ["validate"],
      expectCode: 1,
      expectContains: ["reason=validate-failed", "meta.change"],
    },
    {
      name: "[meta-change-validation] validate passes when meta has keys other than change",
      fix: "h-meta-notes",
      args: ["validate"],
      expectCode: 0,
      expectContains: ["status=success"],
    },
    {
      name: "[meta-change-validation] validate passes when meta.change is valid",
      fix: "h-change-output",
      args: ["validate"],
      expectCode: 0,
      expectContains: ["status=success"],
    },
    {
      name: "[upsert-change] upsert on a spec with no meta creates a meta.change with pending change_status",
      fix: "h-write-update",
      args: [
        "upsert", "change", "--id", "a_b_c_one", "--change",
        'description: brand new description\nmotivation: brand new motivation\nacceptance_criteria: {"0": "c1 new"}',
      ],
      expectCode: 0,
      expectContains: ["action=upsert-change", "a_b_c_one", "path=a_b_c.spec.yaml"],
      expectFile: {
        name: "a_b_c.spec.yaml",
        contains: ["change:", "change_status: pending", "brand new description", "brand new motivation", "c1 new"],
        notContains: ["notes", "history"],
      },
    },
    {
      name: "[upsert-change] upsert with an explicit change_status stores it",
      fix: "h-write-update",
      args: [
        "upsert", "change", "--id", "a_b_c_one", "--change",
        'change_status: approved\ndescription: brand new description',
      ],
      expectCode: 0,
      expectContains: ["action=upsert-change", "a_b_c_one"],
      expectFile: { name: "a_b_c.spec.yaml", contains: ["change_status: approved"] },
    },
    {
      name: "[upsert-change] upsert merges into an existing meta.change",
      fix: "h-change-output",
      args: [
        "upsert", "change", "--id", "a_b_c_one", "--change",
        'description: "updated description v2"\nacceptance_criteria: {"0": "c1 again", new2: "another"}',
      ],
      expectCode: 0,
      expectContains: ["action=upsert-change", "path=a_b_c.spec.yaml"],
      expectFile: {
        name: "a_b_c.spec.yaml",
        contains: [
          "updated description v2",
          "c1 again",
          "another",
          "updated motivation",
          "appended criterion",
          "notes: keep me",
          "change_status: pending",
        ],
        notContains: ["revised criterion"],
      },
    },
    {
      name: "[upsert-change] upsert producing a disallowed key fails schema-invalid",
      fix: "h-write-update",
      args: ["upsert", "change", "--id", "a_b_c_one", "--change", "notes: extra"],
      expectCode: 1,
      expectContains: ["reason=schema-invalid", "meta.change"],
    },
    {
      name: "[upsert-change] upsert with a bad change_status fails schema-invalid",
      fix: "h-write-update",
      args: ["upsert", "change", "--id", "a_b_c_one", "--change", "change_status: merged"],
      expectCode: 1,
      expectContains: ["reason=schema-invalid", "change_status"],
    },
    {
      name: "[upsert-change] upsert of an unknown id fails not-found",
      fix: "s-read-missing",
      args: ["upsert", "change", "--id", "a_b_c_missing", "--change", "change_status: pending"],
      expectCode: 1,
      expectContains: ["reason=not-found"],
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
        for (const s of c.expectNotContains ?? []) {
          expect(out).not.toContain(s);
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
        if (c.expectFileMissing) {
          expect(existsSync(join(dir, c.expectFileMissing))).toBe(false);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe("[meta-change-schema] round trip", () => {
  it("write stores a meta.change and read prints it", () => {
    const dir = freshDir("h-write-create");
    try {
      const w = runIn(dir, [
        "write", "--id", "a_b_c_chg", "--description", "d", "--motivation", "m",
        "--acceptance-criteria", "c1", "c2", "--status", "pending",
        "--meta",
        'change: {change_status: approved, description: "changed d", motivation: "changed m", acceptance_criteria: {"0": "c1 revised", "1": false, new1: "c3 added"}}',
      ]);
      expect(w.code).toBe(0);
      expect(w.out).toContain("action=create");
      const r = runIn(dir, ["read", "--id", "a_b_c_chg"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("change_status: approved");
      expect(r.out).toContain("changed d");
      expect(r.out).toContain("changed m");
      expect(r.out).toContain("c1 revised");
      expect(r.out).toContain("c3 added");
      expect(r.out).toContain("c2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function loadLeaf(dir: string, id: string): Record<string, unknown> {
  const data = parse(readFileSync(join(dir, "a_b_c.spec.yaml"), "utf8")) as {
    specs: Record<string, unknown>[];
  };
  const spec = data.specs.find((s) => s.id === id);
  expect(spec).toBeDefined();
  return spec as Record<string, unknown>;
}

describe("[upsert-change] round trip", () => {
  it("create: read shows the exact passed fields plus change_status pending, other spec fields unchanged", () => {
    const dir = freshDir("h-write-update");
    try {
      const u = runIn(dir, [
        "upsert", "change", "--id", "a_b_c_one", "--change",
        'description: brand new description\nmotivation: brand new motivation\nacceptance_criteria: {"0": "c1 new"}',
      ]);
      expect(u.code).toBe(0);
      const r = runIn(dir, ["read", "--id", "a_b_c_one"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("change_status: pending");
      expect(r.out).toContain("brand new description");
      expect(r.out).toContain("brand new motivation");
      expect(r.out).toContain("c1 new");
      expect(r.out).toContain("first spec");
      expect(r.out).toContain("because we need it");
      expect(r.out).toContain("works correctly");
      expect(r.out).toContain("status: done");
      expect(r.out).not.toContain("notes");
      expect(r.out).not.toContain("history");
      const spec = loadLeaf(dir, "a_b_c_one");
      expect(spec.meta).toEqual({
        change: {
          change_status: "pending",
          description: "brand new description",
          motivation: "brand new motivation",
          acceptance_criteria: { "0": "c1 new" },
        },
      });
      expect(spec.id).toBe("a_b_c_one");
      expect(spec.description).toBe("first spec");
      expect(spec.motivation).toBe("because we need it");
      expect(spec.acceptance_criteria).toEqual(["works correctly"]);
      expect(spec.status).toBe("done");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("create: explicit change_status is respected", () => {
    const dir = freshDir("h-write-update");
    try {
      const u = runIn(dir, [
        "upsert", "change", "--id", "a_b_c_one", "--change",
        'change_status: approved\ndescription: brand new description',
      ]);
      expect(u.code).toBe(0);
      const r = runIn(dir, ["read", "--id", "a_b_c_one"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("change_status: approved");
      expect(r.out).toContain("brand new description");
      const spec = loadLeaf(dir, "a_b_c_one");
      const change = (spec.meta as Record<string, unknown>).change as Record<string, unknown>;
      expect(change.change_status).toBe("approved");
      expect("motivation" in change).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merge: read shows the merged meta.change and every other spec field unchanged", () => {
    const dir = freshDir("h-change-output");
    try {
      const u = runIn(dir, [
        "upsert", "change", "--id", "a_b_c_one", "--change",
        'description: "updated description v2"\nacceptance_criteria: {"0": "c1 again", new2: "another"}',
      ]);
      expect(u.code).toBe(0);
      const r = runIn(dir, ["read", "--id", "a_b_c_one"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("updated description v2");
      expect(r.out).toContain("c1 again");
      expect(r.out).toContain("another");
      expect(r.out).toContain("updated motivation");
      expect(r.out).toContain("appended criterion");
      expect(r.out).toContain("notes: keep me");
      expect(r.out).toContain("change_status: pending");
      expect(r.out).not.toContain("revised criterion");
      expect(r.out).toContain("first spec");
      expect(r.out).toContain("because we need it");
      expect(r.out).toContain("works correctly");
      expect(r.out).toContain("runs fast");
      expect(r.out).toContain("status: done");
      const spec = loadLeaf(dir, "a_b_c_one");
      expect(spec.meta).toEqual({
        change: {
          change_status: "pending",
          description: "updated description v2",
          motivation: "updated motivation",
          acceptance_criteria: { "0": "c1 again", "1": false, new1: "appended criterion", new2: "another" },
        },
        notes: "keep me",
        history: ["applied 2026-01-01"],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("store still validates after upsert", () => {
    const dir = freshDir("h-change-output");
    try {
      const u = runIn(dir, [
        "upsert", "change", "--id", "a_b_c_one", "--change",
        'description: "updated description v2"\nacceptance_criteria: {"0": "c1 again", new2: "another"}',
      ]);
      expect(u.code).toBe(0);
      const v = runIn(dir, ["validate"]);
      expect(v.code).toBe(0);
      expect(v.out).toContain("status=success");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
