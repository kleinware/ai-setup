// Server-side reader for the spec store. Reads every leaf *.spec.yaml file
// and spec/.config.yaml from the spec directory, plus spec_follow_up.yaml
// from the project root that the launcher script passes in via SPEC_ROOT.

import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";

import {
  type FollowUpItem,
  type GitVersions,
  type NoteSet,
  type SpecEntry,
  type SpecVersion,
  type StoreConfig,
  type StoreData,
  specChange,
} from "./spec-types";

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

function entryFromRaw(raw: Record<string, unknown>): SpecEntry {
  return {
    id: String(raw.id ?? ""),
    description: String(raw.description ?? ""),
    motivation: String(raw.motivation ?? ""),
    acceptance_criteria: normalizeCriteria(raw.acceptance_criteria),
    status: asString(raw.status),
    meta: raw.meta === undefined ? undefined : raw.meta,
  };
}

function entriesFromDoc(doc: unknown): SpecEntry[] {
  const list = (doc as { specs?: unknown })?.specs;
  if (!Array.isArray(list)) return [];
  return list.map((entry) => entryFromRaw((entry ?? {}) as Record<string, unknown>));
}

// Specs of every leaf file in the spec dir at a Git state: HEAD, or the
// index (staged). Unparsable files are skipped.
async function gitSpecs(
  top: string,
  relDir: string,
  state: "head" | "index",
): Promise<Map<string, SpecEntry>> {
  const out = new Map<string, SpecEntry>();
  const listing =
    state === "head"
      ? await git(top, ["ls-tree", "-r", "--name-only", "-z", "HEAD", "--", relDir])
      : await git(top, ["ls-files", "--cached", "-z", "--", relDir]);
  if (listing === null) return out;
  for (const rel of listing.split("\0")) {
    if (!rel.endsWith(".spec.yaml")) continue;
    const text = await git(top, ["show", state === "head" ? `HEAD:${rel}` : `:${rel}`]);
    if (text === null) continue;
    try {
      for (const entry of entriesFromDoc(parse(text))) out.set(entry.id, entry);
    } catch {
      // unparsable version: its specs count as absent in that state
    }
  }
  return out;
}

function toVersion(entry: SpecEntry | undefined): SpecVersion | undefined {
  if (!entry) return undefined;
  const criteria = entry.acceptance_criteria;
  return {
    description: entry.description,
    motivation: entry.motivation,
    acceptance_criteria: Array.isArray(criteria) ? criteria : [criteria],
    status: entry.status,
    change: specChange(entry),
  };
}

// The Git side of the store: for every spec that is new, changed, or deleted
// relative to HEAD (judged per spec entry, so a dirty leaf file only flags the
// specs actually touched), its HEAD and index versions. Specs in untracked
// files, or in a repo with no commits, have no HEAD version. Specs that are in
// HEAD but gone from the working tree are returned as `deleted`.
export async function readGitState(
  root: string,
  specDir: string,
  current: SpecEntry[],
): Promise<{ inGit: boolean; gitDiffs: Record<string, GitVersions>; deleted: SpecEntry[] }> {
  const top = (await git(root, ["rev-parse", "--show-toplevel"]))?.trim();
  if (!top) return { inGit: false, gitDiffs: {}, deleted: [] };
  const relDir = path.relative(top, specDir);
  const head = await gitSpecs(top, relDir, "head");
  const index = await gitSpecs(top, relDir, "index");
  const work = new Map(current.map((s) => [s.id, s]));

  const gitDiffs: Record<string, GitVersions> = {};
  const deleted: SpecEntry[] = [];
  for (const id of new Set([...head.keys(), ...work.keys()])) {
    const before = head.get(id);
    const after = work.get(id);
    if (before && after && JSON.stringify(before) === JSON.stringify(after)) continue;
    gitDiffs[id] = { head: toVersion(before), index: toVersion(index.get(id)) };
    if (before && !after) deleted.push({ ...before, deleted: true });
  }
  return { inGit: true, gitDiffs, deleted };
}

// Folder name of the main git project (the main checkout even from a linked
// worktree) and the checked-out branch. Falls back to the root's folder name
// and a null branch outside a git repository.
export async function readRepoInfo(root: string): Promise<{ repoName: string; branch: string | null }> {
  const common = (
    await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  )?.trim();
  let repoName = path.basename(root);
  if (common) {
    const dir = path.basename(common) === ".git" ? path.dirname(common) : common;
    repoName = path.basename(dir.replace(/\.git$/, "")) || repoName;
  }
  let branch: string | null = null;
  if (common) {
    const name = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim();
    branch = name === "HEAD" ? "detached" : name || null;
    if (!name) {
      // Repo with no commits: abbrev-ref fails, symbolic-ref still names the branch.
      branch = (await git(root, ["symbolic-ref", "--short", "HEAD"]))?.trim() || null;
    }
  }
  return { repoName, branch };
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
    specs.push(...entriesFromDoc(doc));
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
  const { inGit, gitDiffs, deleted } = await readGitState(root, specDir, specs);
  specs.push(...deleted);
  specs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const dirtyIds = Object.keys(gitDiffs).sort();
  const { repoName, branch } = await readRepoInfo(root);
  return { root, specDir, repoName, branch, config, specs, followUps, inGit, gitDiffs, dirtyIds, errors };
}
