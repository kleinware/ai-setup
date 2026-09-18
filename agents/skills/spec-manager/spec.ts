// Manage spec entries stored as YAML in per-leaf files under spec/
// (one <leaf>.spec.md file per taxonomy leaf; specs.spec.md when layers is false).
//
// Usage:
//   spec.sh [--spec-dir <dir>] <action> [flags]
//     read     --id <id>
//     write    --id <id> --description <text> --motivation <text> \
//         --acceptance-criteria <criterion> [<criterion> ...] [--status <state>]
//     find     --query <string>
//     validate
//
// --spec-dir <dir> overrides the directory holding the *.spec.md files and
// .config.yaml (default: <repo-root>/spec). Useful for tests.
//
// Repo preferences live in spec/.config.yaml and are validated against
// .config.schema.json in this skill directory on every action.
//
// stdout contract:
//   First line is always a single key=value status line.
//   read: the spec YAML follows after a blank line.
//   find: a YAML list of id/description mappings follows after a blank line.
// Exit codes: 0 success, 1 failure, 2 usage error.

import Ajv from "ajv";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

const CONFIG_FILE = "spec/.config.yaml";
const SCHEMA_FILE = ".config.schema.json";
const STORE_GLOB = "*.spec.md";
const FLAT_FILE = "specs.spec.md";
const TERM_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFAULT_LAYERS = ["area", "component", "section"];

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));

interface Config {
  statusEnabled: boolean;
  states: string[];
  layers: string[];
  structure: Record<string, unknown> | null;
}

const USAGE = `Usage:
  spec.sh [--spec-dir <dir>] <action> [flags]

Actions:
  read     --id <id>
  write    --id <id> --description <text> --motivation <text> --acceptance-criteria <c> [<c> ...] [--status <state>]
  find     --query <string>
  validate

Flags:
  --spec-dir <dir>  directory containing the *.spec.md files and .config.yaml (default: <repo-root>/spec)`;

const KNOWN_FLAGS: Record<string, string[]> = {
  read: ["id"],
  write: ["id", "description", "motivation", "acceptance-criteria", "status"],
  find: ["query"],
  validate: [],
};

const REQUIRED_FLAGS: Record<string, string[]> = {
  read: ["id"],
  write: ["id", "description", "motivation", "acceptance-criteria"],
  find: ["query"],
  validate: [],
};

function kv(v: unknown): string {
  const s = String(v);
  return /\s/.test(s) ? '"' + s.replace(/"/g, '\\"') + '"' : s;
}

function fail(
  reason: string,
  extra: Record<string, unknown> = {},
  problems: string[] | null = null,
): never {
  let line = `status=failed reason=${reason}`;
  const entries = Object.entries(extra);
  if (entries.length) {
    line += " " + entries.map(([k, v]) => `${k}=${kv(v)}`).join(" ");
  }
  console.log(line);
  if (problems) {
    console.log("problems:");
    for (const p of problems) console.log(p);
  }
  process.exit(1);
}

function usage(): never {
  console.error(USAGE);
  process.exit(2);
}

function errLine(e: unknown): string {
  return String(e).split(/\s+/).join(" ");
}

function repoRoot(cwd: string): string {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : cwd;
}

function idRegex(layers: string[]): RegExp {
  return new RegExp(`^[a-z0-9]+(?:-[a-z0-9]+)*(_[a-z0-9]+(?:-[a-z0-9]+)*){${layers.length}}$`);
}

function idPattern(layers: string[]): string {
  return layers.length ? `{${layers.join("_")}}_result` : "a flat result term (no layers)";
}

function withDetail(extra: Record<string, unknown>, detail: string | null): Record<string, unknown> {
  return detail ? { ...extra, error: detail } : extra;
}

function parseArgs(argv: string[]): { action: string; opts: Record<string, string | string[]> } {
  const action = argv[0];
  if (!action || !(action in KNOWN_FLAGS)) usage();
  const allowed = new Set(KNOWN_FLAGS[action]);
  const opts: Record<string, string | string[]> = {};
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith("--")) usage();
    const key = token.slice(2);
    if (!allowed.has(key)) usage();
    if (i + 1 >= rest.length) usage();
    if (key === "acceptance-criteria") {
      const values: string[] = [rest[++i]];
      while (i + 1 < rest.length && !rest[i + 1].startsWith("--")) values.push(rest[++i]);
      opts[key] = values;
    } else {
      opts[key] = rest[++i];
    }
  }
  for (const key of REQUIRED_FLAGS[action]) {
    if (opts[key] === undefined) usage();
  }
  return { action, opts };
}

function checkConfig(data: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const ajv = new Ajv({ strict: false, allErrors: true });
  const schema = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, SCHEMA_FILE), "utf8"));
  const validate = ajv.compile(schema);
  if (!validate(data)) {
    for (const e of validate.errors ?? []) {
      if (e.keyword === "oneOf" || e.keyword === "anyOf") {
        if (e.instancePath === "") {
          problems.push(
            "config: status must be false, a list of state strings, or a list of {state, description?} objects",
          );
        } else if (e.instancePath === "/taxonomy/layers") {
          problems.push(
            "config: taxonomy.layers must be false or a non-empty list of unique layer names",
          );
        }
        continue;
      }
      problems.push(`config: ${e.instancePath || "(root)"} ${e.message}`);
    }
  }
  const status = data.status;
  if (Array.isArray(status) && status.every((s) => typeof s === "object" && s !== null)) {
    const seen = new Set<string>();
    for (const s of status) {
      const state = (s as Record<string, unknown>).state;
      if (typeof state === "string") {
        if (seen.has(state)) problems.push(`config: duplicate status state '${state}'`);
        seen.add(state);
      }
    }
  }
  const tax = data.taxonomy;
  if (typeof tax === "object" && tax !== null && !Array.isArray(tax)) {
    const t = tax as Record<string, unknown>;
    if (t.layers === false) {
      if (t.structure !== undefined) {
        problems.push("config: taxonomy.structure must be omitted when taxonomy.layers is false");
      }
    } else if (Array.isArray(t.layers)) {
      if (t.structure === undefined) {
        problems.push("config: taxonomy.structure is required when taxonomy.layers is a list");
      } else {
        checkStructure(t.structure, t.layers as string[], problems);
      }
    }
  }
  return problems;
}

function checkStructure(structure: unknown, layers: string[], problems: string[]): void {
  const n = layers.length;
  const walk = (node: unknown, depth: number, where: string): void => {
    if (depth === 1) {
      if (!Array.isArray(node)) {
        problems.push(`config: ${where} must be a list of terms`);
        return;
      }
      if (node.length === 0) {
        problems.push(`config: ${where} must list at least one term`);
        return;
      }
      for (const term of node) {
        if (typeof term !== "string" || !TERM_RE.test(term)) {
          problems.push(`config: ${where} term '${term}' must match ${TERM_RE.source}`);
        }
      }
      return;
    }
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      problems.push(`config: ${where} must be a mapping of terms to the next level`);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (Object.keys(obj).length === 0) {
      problems.push(`config: ${where} must declare at least one term`);
      return;
    }
    for (const [term, child] of Object.entries(obj)) {
      if (!TERM_RE.test(term)) {
        problems.push(`config: ${where} term '${term}' must match ${TERM_RE.source}`);
        continue;
      }
      walk(child, depth - 1, `${where}.${term}`);
    }
  };
  walk(structure, n, "taxonomy.structure");
}

function deriveConfig(data: Record<string, unknown>): Config {
  const status = data.status;
  let statusEnabled = false;
  let states: string[] = [];
  if (Array.isArray(status)) {
    statusEnabled = true;
    states = status.map((s) =>
      typeof s === "string" ? s : String((s as Record<string, unknown>).state),
    );
  }
  let layers = DEFAULT_LAYERS;
  let structure: Record<string, unknown> | null = null;
  const tax = data.taxonomy;
  if (typeof tax === "object" && tax !== null && !Array.isArray(tax)) {
    const t = tax as Record<string, unknown>;
    if (t.layers === false) {
      layers = [];
    } else if (Array.isArray(t.layers)) {
      layers = t.layers as string[];
      if (t.structure !== undefined) structure = t.structure as Record<string, unknown>;
    }
  }
  return { statusEnabled, states, layers, structure };
}

function loadConfig(configPath: string): Config {
  if (!fs.existsSync(configPath)) {
    return { statusEnabled: false, states: [], layers: DEFAULT_LAYERS, structure: null };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (e) {
    fail("io-error", { file: CONFIG_FILE, error: errLine(e) });
  }
  let data: unknown;
  try {
    data = parse(raw);
  } catch (e) {
    fail("yaml-error", { file: CONFIG_FILE, error: errLine(e) });
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    fail("config-invalid", { file: CONFIG_FILE }, ["config must be a YAML mapping"]);
  }
  const obj = data as Record<string, unknown>;
  const problems = checkConfig(obj);
  if (problems.length) fail("config-invalid", { file: CONFIG_FILE }, problems);
  return deriveConfig(obj);
}

type Store = {
  files: Record<string, Record<string, unknown>[]>;
  error: string | null;
  detail: string | null;
};

function storeFileForId(id: string, cfg: Config): string {
  if (cfg.layers.length === 0) return FLAT_FILE;
  return id.split("_").slice(0, cfg.layers.length).join("_") + ".spec.md";
}

function listStoreFiles(specDir: string): string[] {
  try {
    return fs
      .readdirSync(specDir)
      .filter((f) => f.endsWith(".spec.md"))
      .sort();
  } catch (e) {
    fail("io-error", { file: "spec/" + STORE_GLOB, error: errLine(e) });
  }
}

function loadFile(specDir: string, name: string): {
  specs: Record<string, unknown>[];
  error: string | null;
  detail: string | null;
} {
  let data: unknown;
  try {
    data = parse(fs.readFileSync(path.join(specDir, name), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { specs: [], error: "missing", detail: null };
    }
    return { specs: [], error: "io-error", detail: errLine(e) };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { specs: [], error: "malformed-store", detail: null };
  }
  const specs = (data as Record<string, unknown>).specs;
  if (!Array.isArray(specs)) return { specs: [], error: "malformed-store", detail: null };
  for (const s of specs) {
    if (
      typeof s !== "object" ||
      s === null ||
      Array.isArray(s) ||
      typeof (s as Record<string, unknown>).id !== "string"
    ) {
      return { specs: [], error: "malformed-store", detail: null };
    }
  }
  return { specs: specs as Record<string, unknown>[], error: null, detail: null };
}

function loadStore(specDir: string): Store {
  if (fs.existsSync(path.join(specDir, "SPECS.md"))) {
    return { files: {}, error: "legacy-store", detail: null };
  }
  const names = listStoreFiles(specDir);
  if (names.length === 0) return { files: {}, error: "spec-file-missing", detail: null };
  const files: Record<string, Record<string, unknown>[]> = {};
  for (const name of names) {
    const f = loadFile(specDir, name);
    if (f.error) return { files: {}, error: f.error, detail: f.detail };
    files[name] = f.specs;
  }
  return { files, error: null, detail: null };
}

function specListYaml(specs: Record<string, unknown>[]): string {
  const raw = stringify({ specs }, { lineWidth: 100 });
  const out: string[] = [];
  let seenItem = false;
  for (const line of raw.split("\n")) {
    if (seenItem && line.startsWith("  - ")) out.push("");
    if (line.startsWith("  - ")) seenItem = true;
    out.push(line);
  }
  return out.join("\n");
}

function writeFile(specPath: string, specs: Record<string, unknown>[]): void {
  const dir = path.dirname(specPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${specPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, specListYaml(specs));
    fs.renameSync(tmp, specPath);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

function specText(spec: Record<string, unknown>): string {
  const parts: string[] = [
    String(spec.id ?? ""),
    String(spec.description ?? ""),
    String(spec.motivation ?? ""),
    String(spec.status ?? ""),
  ];
  const ac = spec.acceptance_criteria;
  if (Array.isArray(ac)) parts.push(...ac.map((x) => String(x)));
  else parts.push(String(ac ?? ""));
  return parts.join("\n");
}

function specProblems(spec: Record<string, unknown>, cfg: Config): string[] {
  const problems: string[] = [];
  const id = String(spec.id);
  const allowed = new Set<string>(["id", "description", "motivation", "acceptance_criteria"]);
  if (cfg.statusEnabled) allowed.add("status");
  for (const key of Object.keys(spec)) {
    if (!allowed.has(key)) problems.push(`${id}: unknown field '${key}'`);
  }
  if (typeof spec.description !== "string" || !spec.description.trim()) {
    problems.push(`${id}: description must be a non-empty string`);
  }
  if (typeof spec.motivation !== "string" || !spec.motivation.trim()) {
    problems.push(`${id}: motivation must be a non-empty string`);
  }
  const ac = spec.acceptance_criteria;
  const acOk =
    typeof ac === "string"
      ? ac.trim() !== ""
      : Array.isArray(ac) && ac.length > 0 && ac.every((c) => typeof c === "string" && c.trim() !== "");
  if (!acOk) {
    problems.push(`${id}: acceptance_criteria must be a non-empty string or a list of non-empty strings`);
  }
  if (cfg.statusEnabled) {
    const st = spec.status;
    if (typeof st !== "string" || !cfg.states.includes(st)) {
      problems.push(`${id}: status must be one of: ${cfg.states.join(", ")}`);
    }
  } else if ("status" in spec) {
    problems.push(`${id}: status is not allowed because status is disabled in ${CONFIG_FILE}`);
  }
  if (!idRegex(cfg.layers).test(id)) {
    problems.push(`${id}: id does not match ${idPattern(cfg.layers)}`);
  }
  return problems;
}

function taxonomyProblem(id: string, cfg: Config): string | null {
  if (!cfg.structure) return null;
  const parts = id.split("_");
  if (parts.length !== cfg.layers.length + 1) return null;
  const n = cfg.layers.length;
  let node: unknown = cfg.structure;
  for (let i = 0; i < n; i++) {
    const part = parts[i];
    if (i < n - 1) {
      if (typeof node !== "object" || node === null || Array.isArray(node) || !(part in (node as Record<string, unknown>))) {
        return `${id}: ${cfg.layers[i]} '${part}' is not declared in the taxonomy structure`;
      }
      node = (node as Record<string, unknown>)[part];
    } else {
      if (!Array.isArray(node) || !node.includes(part)) {
        return `${id}: ${cfg.layers[i]} '${part}' is not declared in the taxonomy structure`;
      }
    }
  }
  return null;
}

function coverageProblems(specs: Record<string, unknown>[], cfg: Config): string[] {
  if (!cfg.structure) return [];
  const n = cfg.layers.length;
  const used = new Set<string>();
  for (const s of specs) {
    const id = String(s.id);
    const parts = id.split("_");
    if (parts.length === n + 1) {
      for (let d = 1; d <= n; d++) used.add(parts.slice(0, d).join("|"));
    }
  }
  const problems: string[] = [];
  const walk = (node: unknown, depth: number, prefix: string[]): void => {
    if (depth === n - 1) {
      for (const term of node as unknown[]) {
        const p = [...prefix, String(term)];
        if (!used.has(p.join("|"))) {
          problems.push(`taxonomy term '${p.join("/")}' (${cfg.layers[depth]}) has no specs`);
        }
      }
      return;
    }
    for (const [term, child] of Object.entries(node as Record<string, unknown>)) {
      const p = [...prefix, term];
      if (!used.has(p.join("|"))) {
        problems.push(`taxonomy term '${p.join("/")}' (${cfg.layers[depth]}) has no specs`);
      }
      walk(child, depth + 1, p);
    }
  };
  walk(cfg.structure, 0, []);
  return problems;
}

function doRead(args: Record<string, string | string[]>, specDir: string, cfg: Config): number {
  const id = args.id as string;
  if (!idRegex(cfg.layers).test(id)) {
    fail("invalid-id", { id, pattern: idPattern(cfg.layers) });
  }
  const store = loadStore(specDir);
  if (store.error) fail(store.error, withDetail({ file: "spec/" + STORE_GLOB, id }, store.detail));
  for (const specs of Object.values(store.files)) {
    for (const spec of specs) {
      if (spec.id === id) {
        console.log(`status=success action=read id=${id}`);
        console.log("");
        console.log(stringify(spec, { lineWidth: 100 }));
        return 0;
      }
    }
  }
  const known = Object.values(store.files)
    .flat()
    .map((s) => String(s.id))
    .join(",");
  fail("not-found", { id, known });
}

function doWrite(args: Record<string, string | string[]>, specDir: string, cfg: Config): number {
  const id = args.id as string;
  if (!idRegex(cfg.layers).test(id)) {
    fail("invalid-id", { id, pattern: idPattern(cfg.layers) });
  }
  const description = args.description as string;
  const motivation = args.motivation as string;
  const criteria = args["acceptance-criteria"] as string[];
  const problems: string[] = [];
  if (!description.trim()) problems.push("--description must be a non-empty string");
  if (!motivation.trim()) problems.push("--motivation must be a non-empty string");
  if (!criteria.length || criteria.some((c) => !c.trim())) {
    problems.push("--acceptance-criteria must be one or more non-empty strings");
  }
  if (problems.length) fail("schema-invalid", { id }, problems);
  let status: string | null = null;
  const statusProblems: string[] = [];
  if (cfg.statusEnabled) {
    status = (args.status as string | undefined) ?? null;
    if (!status) {
      statusProblems.push(`--status is required when status is enabled in ${CONFIG_FILE}; valid states: ${cfg.states.join(", ")}`);
    } else if (!cfg.states.includes(status)) {
      statusProblems.push(`--status '${status}' is not one of the configured states: ${cfg.states.join(", ")}`);
    }
  } else if (args.status !== undefined) {
    statusProblems.push(`--status is not allowed because status is disabled in ${CONFIG_FILE}`);
  }
  if (statusProblems.length) fail("status-invalid", { id }, statusProblems);
  const spec: Record<string, unknown> = {
    id,
    description,
    motivation,
    acceptance_criteria: [...criteria],
  };
  if (status !== null) spec.status = status;
  if (cfg.structure) {
    const tp = taxonomyProblem(id, cfg);
    if (tp) fail("taxonomy-unknown", { id }, [tp]);
  }
  const file = storeFileForId(id, cfg);
  const filePath = path.join(specDir, file);
  if (fs.existsSync(path.join(specDir, "SPECS.md"))) {
    fail("legacy-store", { file: "spec/SPECS.md" });
  }
  const existing = loadFile(specDir, file);
  if (existing.error && existing.error !== "missing") {
    fail(existing.error, withDetail({ file }, existing.detail));
  }
  let specs = existing.specs;
  const action = specs.some((s) => s.id === id) ? "update" : "create";
  specs = specs.filter((s) => s.id !== id);
  specs.push(spec);
  specs.sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
  try {
    writeFile(filePath, specs);
  } catch (e) {
    fail("io-error", { file, error: errLine(e) });
  }
  console.log(
    `status=success action=${action} id=${id} path=${file} taxonomy=${
      cfg.structure ? "checked" : "skipped"
    } has-status=${cfg.statusEnabled}`,
  );
  return 0;
}

function doFind(args: Record<string, string | string[]>, specDir: string, _cfg: Config): number {
  const query = args.query as string;
  const store = loadStore(specDir);
  if (store.error && store.error !== "spec-file-missing") {
    fail(store.error, withDetail({ file: "spec/" + STORE_GLOB }, store.detail));
  }
  const specs = Object.values(store.files).flat();
  const matches = specs
    .filter((s) => specText(s).toLowerCase().includes(query.toLowerCase()))
    .map((s) => ({ id: s.id, description: s.description }));
  console.log(`status=success action=find query=${kv(query)} count=${matches.length}`);
  console.log("");
  console.log(stringify(matches, { lineWidth: 100 }));
  return 0;
}

function doValidate(specDir: string, cfg: Config): number {
  const store = loadStore(specDir);
  if (store.error) fail(store.error, withDetail({ file: "spec/" + STORE_GLOB }, store.detail));
  const specs = Object.values(store.files).flat();
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const s of specs) {
    const id = String(s.id);
    if (seen.has(id)) problems.push(`duplicate id '${id}'`);
    seen.add(id);
    problems.push(...specProblems(s, cfg));
    const tp = taxonomyProblem(id, cfg);
    if (tp) problems.push(tp);
  }
  for (const [name, fileSpecs] of Object.entries(store.files)) {
    for (const s of fileSpecs) {
      const id = String(s.id);
      if (!idRegex(cfg.layers).test(id)) continue;
      const expected = storeFileForId(id, cfg);
      if (expected !== name) {
        problems.push(`${id}: spec is in '${name}' but belongs in '${expected}'`);
      }
    }
  }
  problems.push(...coverageProblems(specs, cfg));
  if (problems.length) {
    fail(
      "validate-failed",
      {
        specs: specs.length,
        "has-status": cfg.statusEnabled,
        taxonomy: cfg.structure ? "checked" : "skipped",
      },
      problems,
    );
  }
  console.log(
    `status=success action=validate specs=${specs.length} has-status=${cfg.statusEnabled} taxonomy=${
      cfg.structure ? "checked" : "skipped"
    }`,
  );
  return 0;
}

function extractSpecDir(argv: string[]): { specDir: string | null; rest: string[] } {
  const rest: string[] = [];
  let specDir: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--spec-dir") {
      if (i + 1 >= argv.length) usage();
      specDir = argv[i + 1];
      i++;
    } else {
      rest.push(argv[i]);
    }
  }
  return { specDir, rest };
}

function main(argv: string[]): number {
  const { specDir: override, rest } = extractSpecDir(argv);
  const { action, opts } = parseArgs(rest);
  const specDir = override ?? path.join(repoRoot(process.cwd()), "spec");
  const cfg = loadConfig(path.join(specDir, ".config.yaml"));
  switch (action) {
    case "read":
      return doRead(opts, specDir, cfg);
    case "write":
      return doWrite(opts, specDir, cfg);
    case "find":
      return doFind(opts, specDir, cfg);
    default:
      return doValidate(specDir, cfg);
  }
}

process.exit(main(process.argv.slice(2)));
