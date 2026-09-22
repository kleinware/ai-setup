// POST /api/follow-ups — updates one saved follow-up note field for a spec in
// spec/spec_follow_up.yaml, keeping the file sorted and well-formed.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { parse, stringify } from "yaml";

import { projectRoot, readStore } from "@/lib/spec-store";
import type { FollowUpItem, SpecEntry, StoreData } from "@/lib/spec-types";
import { atomicWrite } from "@/lib/spec-writer";

export const dynamic = "force-dynamic";

const FOLLOW_UP_FILE = "spec_follow_up.yaml";
const FIELDS = ["description", "motivation", "criterion"] as const;

type Field = (typeof FIELDS)[number];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

// Keep only items with a string id and only the known fields; criteria keys
// become numeric strings mapped to string values.
function normalizeItems(doc: unknown): FollowUpItem[] {
  const items = (doc as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => isPlainObject(item) && typeof item.id === "string")
    .map((item) => {
      const criteria = item.acceptance_criteria;
      return {
        id: item.id as string,
        description: typeof item.description === "string" ? item.description : undefined,
        motivation: typeof item.motivation === "string" ? item.motivation : undefined,
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

// Item field order: id, description, motivation, acceptance_criteria;
// criterion keys in numeric ascending order.
function itemsYaml(items: FollowUpItem[]): string {
  const ordered = items
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((item) => {
      const out: Record<string, unknown> = { id: item.id };
      if (item.description !== undefined) out.description = item.description;
      if (item.motivation !== undefined) out.motivation = item.motivation;
      if (item.acceptance_criteria !== undefined) {
        const keys = Object.keys(item.acceptance_criteria).sort(
          (a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10),
        );
        out.acceptance_criteria = Object.fromEntries(
          keys.map((k) => [k, item.acceptance_criteria![k]]),
        );
      }
      return out;
    });
  return stringify({ items: ordered }, { lineWidth: 100 });
}

function criteriaCount(spec: SpecEntry): number {
  const c = spec.acceptance_criteria;
  if (Array.isArray(c)) return c.length;
  return c.length > 0 ? 1 : 0;
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid-body" }, { status: 400 });
  }
  if (!isPlainObject(body)) {
    return NextResponse.json({ error: "invalid-body" }, { status: 400 });
  }
  const id = body.id;
  const field = body.field;
  const value = body.value;
  const index = body.index;
  if (typeof id !== "string" || typeof value !== "string") {
    return NextResponse.json({ error: "invalid-body" }, { status: 400 });
  }
  let noteField: Field | undefined;
  if (typeof field === "string" && (FIELDS as readonly string[]).includes(field)) {
    noteField = field as Field;
  }
  if (noteField === undefined) {
    return NextResponse.json({ error: "invalid-field" }, { status: 400 });
  }
  let criterionIndex: number | undefined;
  if (noteField === "criterion") {
    if (!Number.isInteger(index) || (index as number) < 0) {
      return NextResponse.json({ error: "invalid-field" }, { status: 400 });
    }
    criterionIndex = index as number;
  }

  let data: StoreData;
  try {
    data = await readStore();
  } catch {
    return NextResponse.json({ error: "io-error" }, { status: 500 });
  }
  const spec = data.specs.find((s) => s.id === id);
  if (!spec) {
    return NextResponse.json({ error: "not-found" }, { status: 404 });
  }
  if (criterionIndex !== undefined && criterionIndex >= criteriaCount(spec)) {
    return NextResponse.json({ error: "invalid-field" }, { status: 400 });
  }

  const file = path.join(projectRoot(), "spec", FOLLOW_UP_FILE);
  let items: FollowUpItem[];
  try {
    let doc: unknown;
    try {
      doc = parse(await fsp.readFile(file, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        doc = { items: [] };
      } else {
        throw e;
      }
    }
    items = normalizeItems(doc);
  } catch {
    return NextResponse.json({ error: "io-error" }, { status: 500 });
  }

  let item = items.find((i) => i.id === id);
  if (!item) {
    item = { id };
    items.push(item);
  }
  if (noteField === "criterion") {
    const key = String(criterionIndex);
    if (value === "") {
      if (item.acceptance_criteria) {
        delete item.acceptance_criteria[key];
        if (Object.keys(item.acceptance_criteria).length === 0) {
          delete item.acceptance_criteria;
        }
      }
    } else {
      item.acceptance_criteria = {
        ...(item.acceptance_criteria ?? {}),
        [key]: value,
      };
    }
  } else if (value === "") {
    delete item[noteField];
  } else {
    item[noteField] = value;
  }

  try {
    await atomicWrite(file, itemsYaml(items));
  } catch {
    return NextResponse.json({ error: "io-error" }, { status: 500 });
  }

  return NextResponse.json({ id, item });
}
