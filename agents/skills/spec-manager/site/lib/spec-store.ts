// Server-side reader for the spec store. Reads every leaf *.spec.yaml file
// and spec/.config.yaml from the spec directory, plus spec_follow_up.yaml
// from the project root that the launcher script passes in via SPEC_ROOT.

import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";

import type { FollowUpItem, NoteSet, SpecEntry, StoreConfig, StoreData } from "./spec-types";

const execFileAsync = promisify(execFile);

export function projectRoot(): string {
  return process.env.SPEC_ROOT ?? process.cwd();
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeCriteria(value: unknown): string | string[] {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((c) => String(c));
  if (value != null) return String(value);
  return "";
}

export function normalizeNoteSet(raw: Record<string, unknown>): NoteSet {
  const criteria = raw.acceptance_criteria;
  return {
    description: asString(raw.description),
    motivation: asString(raw.motivation),
    acceptance_criteria:
      criteria != null && typeof criteria === "object" && !Array.isArray(criteria)
        ? Object.fromEntries(
            Object.entries(criteria as Record<string, unknown>).map(([k, v]) => [
              String(k),
              String(v),
            ]),
          )
        : undefined,
  };
}

export function normalizeFollowUps(doc: unknown): FollowUpItem[] {
  const items = (doc as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item != null && typeof (item as { id?: unknown }).id === "string")
    .map((item) => {
      const raw = item as Record<string, unknown>;
      const change = raw.change;
      return {
        id: raw.id as string,
        ...normalizeNoteSet(raw),
        change:
          change != null && typeof change === "object" && !Array.isArray(change)
            ? normalizeNoteSet(change as Record<string, unknown>)
            : undefined,
      };
    });
}

function normalizeConfig(doc: unknown): StoreConfig | null {
  if (doc == null || typeof doc !== "object") return null;
  const raw = doc as Record<string, unknown>;
  const status =
    raw.status === undefined
      ? false
      : raw.status === false
        ? false
        : Array.isArray(raw.status)
          ? (raw.status as Array<{ name: string; description: string }>)
          : false;
  const taxonomy = raw.taxonomy as
    | undefined
    | { layers?: unknown; structure?: Record<string, unknown> };
  let normalized: StoreConfig["taxonomy"];
  if (taxonomy != null) {
    if (taxonomy.layers === false) normalized = { layers: false };
    else if (Array.isArray(taxonomy.layers))
      normalized = {
        layers: taxonomy.layers.map(String),
        structure: taxonomy.structure,
      };
  }
  return { status, taxonomy: normalized };
}

async function git(root: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

function specsById(doc: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const list = (doc as { specs?: unknown })?.specs;
  if (!Array.isArray(list)) return out;
  for (const entry of list) {
    const id = String((entry as { id?: unknown })?.id ?? "");
    out.set(id, JSON.stringify(entry));
  }
  return out;
}

// Ids of specs that are new or changed relative to HEAD, judged per spec entry
// so a dirty leaf file only flags the specs actually touched. Specs in
// untracked files, or in a repo with no commits, all count as dirty.
export async function readDirtyIds(root: string, specDir: string): Promise<string[]> {
  const top = (await git(root, ["rev-parse", "--show-toplevel"]))?.trim();
  if (!top) return [];
  const status = await git(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--",
    specDir,
  ]);
  if (status === null) return [];

  const dirty = new Set<string>();
  const entries = status.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const rel = entry.slice(3);
    if (code[0] === "R" || code[0] === "C") i++; // skip the rename source path
    if (!rel.endsWith(".spec.yaml") || code.includes("D")) continue;
    const abs = path.resolve(top, rel);
    let current: Map<string, string>;
    try {
      current = specsById(parse(await fsp.readFile(abs, "utf8")));
    } catch {
      continue;
    }
    const head = await git(root, ["show", `HEAD:${rel}`]);
    let before = new Map<string, string>();
    if (head !== null && code !== "??" && code !== "A ") {
      try {
        before = specsById(parse(head));
      } catch {
        // unparsable HEAD version: treat every spec in the file as dirty
      }
    }
    for (const [id, json] of current) {
      if (before.get(id) !== json) dirty.add(id);
    }
  }
  return [...dirty].sort();
}

export async function readStore(): Promise<StoreData> {
  const root = projectRoot();
  const specDir = path.join(root, "spec");
  const errors: string[] = [];
  const specs: SpecEntry[] = [];
  let config: StoreConfig | null = null;
  let followUps: FollowUpItem[] = [];

  let names: string[];
  try {
    names = await fsp.readdir(specDir);
  } catch {
    errors.push(`spec directory not found: ${specDir}`);
    names = [];
  }

  for (const name of names.sort()) {
    const file = path.join(specDir, name);
    let doc: unknown;
    try {
      doc = parse(await fsp.readFile(file, "utf8"));
    } catch (e) {
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (name === ".config.yaml") {
      config = normalizeConfig(doc);
      continue;
    }
    if (!name.endsWith(".spec.yaml")) continue;
    const list = (doc as { specs?: unknown })?.specs;
    if (!Array.isArray(list)) {
      errors.push(`${name}: not a specs: list`);
      continue;
    }
    for (const entry of list) {
      const raw = entry as Record<string, unknown>;
      specs.push({
        id: String(raw.id ?? ""),
        description: String(raw.description ?? ""),
        motivation: String(raw.motivation ?? ""),
        acceptance_criteria: normalizeCriteria(raw.acceptance_criteria),
        status: asString(raw.status),
        meta: raw.meta === undefined ? undefined : raw.meta,
      });
    }
  }

  // The follow-up file lives at the project root, outside the spec directory.
  try {
    followUps = normalizeFollowUps(
      parse(await fsp.readFile(path.join(root, "spec_follow_up.yaml"), "utf8")),
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      errors.push(`spec_follow_up.yaml: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  specs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  followUps.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const dirtyIds = await readDirtyIds(root, specDir);
  return { root, specDir, config, specs, followUps, dirtyIds, errors };
}
