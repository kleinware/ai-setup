// POST /api/follow-ups — updates one saved follow-up note field for a spec in
// spec_follow_up.yaml at the project root, keeping the file sorted and well-formed.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { parse, stringify } from "yaml";

import { normalizeFollowUps, projectRoot, readStore } from "@/lib/spec-store";
import type { FollowUpItem, NoteSet, SpecEntry, StoreData } from "@/lib/spec-types";
import { specChange } from "@/lib/spec-types";
import { atomicWrite } from "@/lib/spec-writer";

export const dynamic = "force-dynamic";

const FOLLOW_UP_FILE = "spec_follow_up.yaml";
const FIELDS = ["description", "motivation", "criterion"] as const;

type Field = (typeof FIELDS)[number];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

// Criterion keys in display order: numeric indexes ascending, then newN keys.
function sortedCriteria(criteria: Record<string, string>): Record<string, string> {
  const rank = (k: string) => (k.startsWith("new") ? 1 : 0);
  const num = (k: string) => Number.parseInt(k.replace(/^new/, ""), 10);
  const keys = Object.keys(criteria).sort((a, b) => rank(a) - rank(b) || num(a) - num(b));
  return Object.fromEntries(keys.map((k) => [k, criteria[k]]));
}

function orderedNotes(notes: NoteSet): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (notes.description !== undefined) out.description = notes.description;
  if (notes.motivation !== undefined) out.motivation = notes.motivation;
  if (notes.acceptance_criteria !== undefined) {
    out.acceptance_criteria = sortedCriteria(notes.acceptance_criteria);
  }
  return out;
}

// Item field order: id, description, motivation, acceptance_criteria, change
// (the same three note fields, for the spec's proposed change).
function itemsYaml(items: FollowUpItem[]): string {
  const ordered = items
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((item) => {
      const out: Record<string, unknown> = { id: item.id, ...orderedNotes(item) };
      if (item.change !== undefined) out.change = orderedNotes(item.change);
      return out;
    });
  return stringify({ items: ordered }, { lineWidth: 100 });
}

function hasNotes(notes: NoteSet | undefined): boolean {
  return (
    notes !== undefined &&
    (notes.description !== undefined ||
      notes.motivation !== undefined ||
      notes.acceptance_criteria !== undefined)
  );
}

function criteriaCount(spec: SpecEntry): number {
  const c = spec.acceptance_criteria;
  if (Array.isArray(c)) return c.length;
  return c.length > 0 ? 1 : 0;
}

// Serialize read-modify-write cycles on the follow-up file so concurrent
// saves cannot clobber each other's writes.
const fileLocks = new Map<string, Promise<void>>();

function withFileLock(file: string, fn: () => Promise<void>): Promise<void> {
  const prev = fileLocks.get(file) ?? Promise.resolve();
  const next = prev.then(() => fn());
  fileLocks.set(file, next.catch(() => undefined));
  return next;
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
  const key = body.key;
  const target = body.target;
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
  if (target !== undefined && target !== "spec" && target !== "change") {
    return NextResponse.json({ error: "invalid-field" }, { status: 400 });
  }
  const forChange = target === "change";
  // Spec criteria are addressed by index; change criteria by their
  // meta.change.acceptance_criteria key ("0", "new1", ...).
  let criterionKey: string | undefined;
  if (noteField === "criterion") {
    if (forChange) {
      if (typeof key !== "string") {
        return NextResponse.json({ error: "invalid-field" }, { status: 400 });
      }
      criterionKey = key;
    } else {
      if (!Number.isInteger(index) || (index as number) < 0) {
        return NextResponse.json({ error: "invalid-field" }, { status: 400 });
      }
      criterionKey = String(index);
    }
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
  if (forChange) {
    const change = specChange(spec);
    if (!change) {
      return NextResponse.json({ error: "invalid-field" }, { status: 400 });
    }
    if (
      criterionKey !== undefined &&
      !Object.keys(change.acceptance_criteria ?? {}).includes(criterionKey)
    ) {
      return NextResponse.json({ error: "invalid-field" }, { status: 400 });
    }
  } else if (criterionKey !== undefined && Number(criterionKey) >= criteriaCount(spec)) {
    return NextResponse.json({ error: "invalid-field" }, { status: 400 });
  }

  const file = path.join(projectRoot(), FOLLOW_UP_FILE);
  let item: FollowUpItem | undefined;
  try {
    await withFileLock(file, async () => {
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
      const items = normalizeFollowUps(doc);
      let found = items.find((i) => i.id === id);
      if (!found) {
        found = { id };
        items.push(found);
      }
      const notes: NoteSet = forChange ? (found.change ??= {}) : found;
      if (noteField === "criterion") {
        const k = criterionKey!;
        if (value === "") {
          if (notes.acceptance_criteria) {
            delete notes.acceptance_criteria[k];
            if (Object.keys(notes.acceptance_criteria).length === 0) {
              delete notes.acceptance_criteria;
            }
          }
        } else {
          notes.acceptance_criteria = {
            ...(notes.acceptance_criteria ?? {}),
            [k]: value,
          };
        }
      } else if (value === "") {
        delete notes[noteField];
      } else {
        notes[noteField] = value;
      }
      if (forChange && !hasNotes(found.change)) delete found.change;

      // An item with no data left is removed from the file, and the file
      // itself is deleted when it was the last item.
      const hasData = hasNotes(found) || hasNotes(found.change);
      if (!hasData) {
        items.splice(items.indexOf(found), 1);
      }
      item = hasData ? found : undefined;

      if (items.length === 0) {
        await fsp.unlink(file).catch((e) => {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        });
      } else {
        await atomicWrite(file, itemsYaml(items));
      }
    });
  } catch {
    return NextResponse.json({ error: "io-error" }, { status: 500 });
  }

  return NextResponse.json({ id, item });
}
