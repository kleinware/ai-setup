// Server-side reader for the spec store. Reads every leaf *.spec.yaml file,
// spec/.config.yaml, and spec/spec_follow_up.yaml from the project root that
// the launcher script passes in via SPEC_ROOT.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

import type { FollowUpItem, SpecEntry, StoreConfig, StoreData } from "./spec-types";

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

function normalizeFollowUps(doc: unknown): FollowUpItem[] {
  const items = (doc as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item != null && typeof (item as { id?: unknown }).id === "string")
    .map((item) => {
      const raw = item as Record<string, unknown>;
      const criteria = raw.acceptance_criteria;
      return {
        id: raw.id as string,
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
    if (name === "spec_follow_up.yaml") {
      followUps = normalizeFollowUps(doc);
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

  specs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  followUps.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { root, specDir, config, specs, followUps, errors };
}
