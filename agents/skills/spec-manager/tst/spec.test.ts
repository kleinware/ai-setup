import { describe, it, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SKILL_DIR = join(import.meta.dir, "..");
const SCRIPT = join(SKILL_DIR, "spec.ts");
const FIXTURES = join(import.meta.dir, "fixtures");

function run(fix: string | null, args: string[]): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "spec-tst-"));
  if (fix) cpSync(join(FIXTURES, fix), dir, { recursive: true });
  try {
    try {
      const out = execFileSync("bun", [SCRIPT, "--spec-dir", dir, ...args], { encoding: "utf-8" });
      return { code: 0, out: out as string };
    } catch (e: unknown) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      const out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
      return { code: err.status ?? 1, out };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type Case = {
  name: string;
  fix: string | null;
  args: string[];
  expectCode: number;
  expectContains: string[];
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
    name: "write creates new spec",
    fix: "h-write-create",
    args: ["write", "--id", "a_b_d_two", "--description", "second spec", "--motivation", "because", "--acceptance-criteria", "ok", "--status", "pending"],
    expectCode: 0,
    expectContains: ["action=create", "a_b_d_two"],
  },
  {
    name: "write updates existing spec",
    fix: "h-write-update",
    args: ["write", "--id", "a_b_c_one", "--description", "first spec v2", "--motivation", "because", "--acceptance-criteria", "ok", "--status", "done"],
    expectCode: 0,
    expectContains: ["action=update", "a_b_c_one"],
  },
  {
    name: "find returns matches",
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
];

describe("spec-manager CLI", () => {
  for (const c of cases) {
    it(c.name, () => {
      const { code, out } = run(c.fix, c.args);
      expect(code).toBe(c.expectCode);
      for (const s of c.expectContains) {
        expect(out).toContain(s);
      }
    });
  }
});
