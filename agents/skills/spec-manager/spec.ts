// Manage spec entries stored as YAML in per-leaf files under spec/
// (one <leaf>.spec.md file per taxonomy leaf; specs.spec.md when layers is false).
//
// Usage:
//   spec.sh [--spec-dir <dir>] <action> [flags]
//     read     --id <id>
//     write    --id <id> --description <text> --motivation <text> \
//         --acceptance-criteria <criterion> [<criterion> ...] [--status <state>]
//     find     --query <string>
//     query    config
//              tasks [--status <state>] [--layer <path> ...]
//     validate
//     config   get
//              set [--status <state> ...] [--layers <layer> ...] [--structure <yaml>]
//              add --term <term> [--parent <path>]
//              remove --term <term> [--parent <path>]
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
  query    config
           tasks [--status <state>] [--layer <path> ...]
  validate
  config   get
           set [--status <state> ... | false] [--layers <layer> ... | false] [--structure <yaml>]
           add --term <term> [--parent <path>]
           remove --term <term> [--parent <path>]

Flags:
  --spec-dir <dir>  directory containing the *.spec.md files and .config.yaml (default: <repo-root>/spec)`;

const KNOWN_FLAGS: Record<string, string[]> = {
  read: ["id"],
  write: ["id", "description", "motivation", "acceptance-criteria", "status"],
  find: ["query"],
  query: ["status", "layer"],
  validate: [],
  config: ["status", "layers", "structure", "term", "parent"],
};

const REQUIRED_FLAGS: Record<string, string[]> = {
  read: ["id"],
  write: ["id", "description", "motivation", "acceptance-criteria"],
  find: ["query"],
  query: [],
  validate: [],
  config: [],
};

const CONFIG_SUBCOMMANDS = ["get", "set", "add", "remove"];
const QUERY_SUBCOMMANDS = ["config", "tasks"];
const SUBCOMMANDS: Record<string, string[]> = {
  config: CONFIG_SUBCOMMANDS,
  query: QUERY_SUBCOMMANDS,
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

function parseArgs(argv: string[]): {
  action: string;
  sub: string | null;
  opts: Record<string, string | string[]>;
} {
  const action = argv[0];
  if (!action || !(action in KNOWN_FLAGS)) usage();
  let sub: string | null = null;
  let rest = argv.slice(1);
  if (action in SUBCOMMANDS) {
    if (rest.length === 0 || !SUBCOMMANDS[action].includes(rest[0])) usage();
    sub = rest[0];
    rest = rest.slice(1);
  }
  const allowed = new Set(KNOWN_FLAGS[action]);
  const opts: Record<string, string | string[]> = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith("--")) usage();
    const key = token.slice(2);
    if (!allowed.has(key)) usage();
    if (i + 1 >= rest.length) usage();
    if (key === "acceptance-criteria" || (action === "config" && (key === "status" || key === "layers"))) {
      const values: string[] = [rest[++i]];
      while (i + 1 < rest.length && !rest[i + 1].startsWith("--")) values.push(rest[++i]);
      opts[key] = values;
    } else if (action === "query" && key === "layer") {
      const values: string[] = Array.isArray(opts[key]) ? (opts[key] as string[]) : [];
      values.push(rest[++i]);
      opts[key] = values;
    } else {
      opts[key] = rest[++i];
    }
  }
  for (const key of REQUIRED_FLAGS[action]) {
    if (opts[key] === undefined) usage();
  }
  return { action, sub, opts };
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

function loadRawConfig(configPath: string): Record<string, unknown> | null {
  if (!fs.existsSync(configPath)) return null;
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
  return data as Record<string, unknown>;
}

function loadConfig(configPath: string): Config {
  const obj = loadRawConfig(configPath);
  if (!obj) {
    return { statusEnabled: false, states: [], layers: DEFAULT_LAYERS, structure: null };
  }
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

function atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

function writeFile(specPath: string, specs: Record<string, unknown>[]): void {
  atomicWrite(specPath, specListYaml(specs));
}

function writeConfig(configPath: string, data: Record<string, unknown>): void {
  try {
    atomicWrite(configPath, stringify(data, { lineWidth: 100 }));
  } catch (e) {
    fail("io-error", { file: CONFIG_FILE, error: errLine(e) });
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

function doQueryConfig(specDir: string): number {
  const configPath = path.join(specDir, ".config.yaml");
  const raw = loadRawConfig(configPath);
  if (raw === null) {
    console.log(`status=success action=query-config file=missing`);
    return 0;
  }
  const problems = checkConfig(raw);
  if (problems.length) fail("config-invalid", { file: CONFIG_FILE }, problems);
  const cfg = deriveConfig(raw);
  const out: Record<string, unknown> = {
    status: Array.isArray(raw.status) ? raw.status : false,
    layers: cfg.layers.length ? cfg.layers : false,
  };
  if (cfg.structure) out.structure = cfg.structure;
  console.log(`status=success action=query-config`);
  console.log("");
  console.log(stringify(out, { lineWidth: 100 }));
  return 0;
}

function doQueryTasks(args: Record<string, string | string[]>, specDir: string, cfg: Config): number {
  const status = args.status as string | undefined;
  const layerPaths = args.layer as string[] | undefined;
  if (status === undefined && (!layerPaths || layerPaths.length === 0)) usage();
  if (status !== undefined) {
    if (!cfg.statusEnabled) {
      fail("status-invalid", { status }, [`--status is not allowed because status is disabled in ${CONFIG_FILE}`]);
    }
    if (!cfg.states.includes(status)) {
      fail("status-invalid", { status }, [`--status '${status}' is not one of the configured states: ${cfg.states.join(", ")}`]);
    }
  }
  const paths: string[][] = [];
  if (layerPaths && layerPaths.length > 0) {
    if (cfg.layers.length === 0) {
      fail("layer-invalid", { layer: layerPaths.join(", ") }, [
        "--layer is not allowed because taxonomy.layers is false",
      ]);
    }
    for (const p of layerPaths) {
      const parts = p.split("/");
      if (parts.length === 0 || parts.some((x) => x === "") || parts.length > cfg.layers.length) {
        fail("layer-invalid", { layer: p }, [
          `layer path must be 1..${cfg.layers.length} layer terms separated by '/'`,
        ]);
      }
      if (cfg.structure) {
        let node: unknown = cfg.structure;
        for (let i = 0; i < parts.length; i++) {
          if (i === cfg.layers.length - 1) {
            if (!Array.isArray(node) || !(node as unknown[]).includes(parts[i])) {
              fail("taxonomy-unknown", { layer: p }, [
                `layer term '${parts[i]}' (${cfg.layers[i]}) is not declared in the taxonomy structure`,
              ]);
            }
            break;
          }
          const m = node as Record<string, unknown>;
          if (typeof node !== "object" || node === null || Array.isArray(node) || !(parts[i] in m)) {
            fail("taxonomy-unknown", { layer: p }, [
              `layer term '${parts[i]}' (${cfg.layers[i]}) is not declared in the taxonomy structure`,
            ]);
          }
          node = m[parts[i]];
        }
      }
      paths.push(parts);
    }
  }
  const store = loadStore(specDir);
  if (store.error && store.error !== "spec-file-missing") {
    fail(store.error, withDetail({ file: "spec/" + STORE_GLOB }, store.detail));
  }
  const idRe = cfg.layers.length ? idRegex(cfg.layers) : null;
  const matches = Object.values(store.files)
    .flat()
    .filter((s) => {
      if (status !== undefined && s.status !== status) return false;
      if (paths.length) {
        const id = String(s.id);
        if (!idRe || !idRe.test(id)) return false;
        const idParts = id.split("_").slice(0, cfg.layers.length);
        if (!paths.some((p) => p.every((t, i) => idParts[i] === t))) return false;
      }
      return true;
    });
  const results = matches.map((s) => {
    const m: Record<string, unknown> = { id: s.id, description: s.description };
    if (cfg.statusEnabled) m.status = s.status;
    return m;
  });
  const line =
    `status=success action=query-tasks` +
    (status !== undefined ? ` status=${kv(status)}` : "") +
    paths.map((p) => ` layer=${kv(p.join("/"))}`).join("") +
    ` count=${matches.length}`;
  console.log(line);
  console.log("");
  console.log(stringify(results, { lineWidth: 100 }));
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

function doConfigSet(args: Record<string, string | string[]>, specDir: string): number {
  const configPath = path.join(specDir, ".config.yaml");
  const hasStatus = args.status !== undefined;
  const hasLayers = args.layers !== undefined;
  const hasStructure = args.structure !== undefined;
  if (!hasStatus && !hasLayers && !hasStructure) usage();
  const existing = loadRawConfig(configPath);
  const data: Record<string, unknown> = { ...(existing ?? {}) };
  if (hasStatus) {
    const vals = args.status as string[];
    if (vals.length === 1 && vals[0] === "false") {
      data.status = false;
    } else {
      data.status = vals.map((v) => {
        const i = v.indexOf(":");
        return i === -1 ? v : { state: v.slice(0, i), description: v.slice(i + 1) };
      });
    }
  }
  if (hasLayers || hasStructure) {
    const t: Record<string, unknown> = {
      ...((existing ?? {}).taxonomy as Record<string, unknown> | undefined),
    };
    if (hasLayers) {
      const vals = args.layers as string[];
      const isFalse = vals.length === 1 && vals[0] === "false";
      t.layers = isFalse ? false : [...vals];
      if (isFalse) delete t.structure;
    }
    if (hasStructure) {
      let parsed: unknown;
      try {
        parsed = parse(args.structure as string);
      } catch (e) {
        fail("yaml-error", { file: "taxonomy.structure", error: errLine(e) });
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        fail("config-invalid", { file: CONFIG_FILE }, ["--structure must be a YAML mapping"]);
      }
      t.structure = parsed;
    }
    if (t.layers === false && t.structure !== undefined) {
      fail("config-invalid", { file: CONFIG_FILE }, [
        "taxonomy.structure must be omitted when taxonomy.layers is false",
      ]);
    }
    data.taxonomy = t;
  }
  const problems = checkConfig(data);
  if (problems.length) fail("config-invalid", { file: CONFIG_FILE }, problems);
  writeConfig(configPath, data);
  console.log(`status=success action=config-set path=${CONFIG_FILE}`);
  return 0;
}

function doConfig(
  args: Record<string, string | string[]>,
  sub: string,
  specDir: string,
  cfg: Config,
): number {
  const configPath = path.join(specDir, ".config.yaml");

  if (sub === "get") {
    if (!fs.existsSync(configPath)) {
      console.log(`status=success action=config-get file=missing`);
      return 0;
    }
    let raw: string;
    try {
      raw = fs.readFileSync(configPath, "utf8");
    } catch (e) {
      fail("io-error", { file: CONFIG_FILE, error: errLine(e) });
    }
    console.log(`status=success action=config-get path=${CONFIG_FILE}`);
    console.log("");
    console.log(raw);
    return 0;
  }

  // add / remove: edit the taxonomy structure of an existing config.
  const term = args.term as string | undefined;
  if (!term || !TERM_RE.test(term)) usage();
  const existing = loadRawConfig(configPath);
  if (!existing) fail("config-missing", { file: CONFIG_FILE });
  const n = cfg.layers.length;
  if (n === 0) {
    fail("config-invalid", { file: CONFIG_FILE }, [
      "taxonomy.layers is false; there are no taxonomy terms to modify",
    ]);
  }
  const tax = existing.taxonomy as Record<string, unknown> | undefined;
  const structure = tax?.structure;
  if (typeof structure !== "object" || structure === null || Array.isArray(structure)) {
    fail("config-invalid", { file: CONFIG_FILE }, ["taxonomy.structure must be a mapping"]);
  }
  const parent = args.parent as string | undefined;
  const pathParts = parent === undefined ? [] : parent.split("/");
  let node: unknown = structure;
  const ancestors: { parent: Record<string, unknown>; key: string }[] = [];
  for (const part of pathParts) {
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      fail("term-not-found", { term }, [
        `parent path '${pathParts.join("/")}' is not a valid path in taxonomy.structure`,
      ]);
    }
    const m = node as Record<string, unknown>;
    if (!(part in m)) {
      fail("term-not-found", { term }, [`parent term '${part}' is not declared in taxonomy.structure`]);
    }
    ancestors.push({ parent: m, key: part });
    node = m[part];
  }

  if (sub === "add") {
    if (!Array.isArray(node)) {
      fail("term-not-found", { term }, [
        `cannot add '${term}' here; --parent must point to a list of terms (depth ${n - 1}); use 'config set --structure' to create intermediate branches`,
      ]);
    }
    if (node.includes(term)) {
      fail("term-exists", { term, where: pathParts.join("/") || "(root)" }, [
        `term '${term}' is already declared`,
      ]);
    }
    node.push(term);
  } else {
    if (Array.isArray(node)) {
      const i = node.indexOf(term);
      if (i === -1) {
        fail("term-not-found", { term, known: (node as unknown[]).join(",") }, [
          `term '${term}' is not in the list; known: ${(node as unknown[]).join(", ")}`,
        ]);
      }
      node.splice(i, 1);
    } else if (typeof node === "object" && node !== null) {
      if (!(term in (node as Record<string, unknown>))) {
        fail("term-not-found", { term, known: Object.keys(node as Record<string, unknown>).join(",") }, [
          `term '${term}' is not declared; known: ${Object.keys(node as Record<string, unknown>).join(", ")}`,
        ]);
      }
      delete (node as Record<string, unknown>)[term];
    } else {
      fail("term-not-found", { term }, [`term '${term}' is not found in taxonomy.structure`]);
    }
    let cur: unknown = node;
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const empty = Array.isArray(cur)
        ? cur.length === 0
        : typeof cur === "object" && cur !== null && Object.keys(cur as Record<string, unknown>).length === 0;
      if (!empty) break;
      const { parent: p, key } = ancestors[i];
      delete p[key];
      cur = p;
    }
  }

  const problems = checkConfig(existing);
  if (problems.length) fail("config-invalid", { file: CONFIG_FILE }, problems);
  writeConfig(configPath, existing);
  console.log(`status=success action=config-${sub} term=${term} path=${CONFIG_FILE}`);
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
  const { action, sub, opts } = parseArgs(rest);
  const specDir = override ?? path.join(repoRoot(process.cwd()), "spec");
  const configPath = path.join(specDir, ".config.yaml");
  // config set validates the resulting config, so it can run on (and fix) a broken one.
  if (action === "config" && sub === "set") {
    return doConfigSet(opts, specDir);
  }
  const cfg = loadConfig(configPath);
  switch (action) {
    case "read":
      return doRead(opts, specDir, cfg);
    case "write":
      return doWrite(opts, specDir, cfg);
    case "find":
      return doFind(opts, specDir, cfg);
    case "query":
      return sub === "config" ? doQueryConfig(specDir) : doQueryTasks(opts, specDir, cfg);
    case "config":
      return doConfig(opts, sub as string, specDir, cfg);
    default:
      return doValidate(specDir, cfg);
  }
}

process.exit(main(process.argv.slice(2)));
