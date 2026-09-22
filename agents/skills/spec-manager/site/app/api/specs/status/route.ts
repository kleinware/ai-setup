// POST /api/specs/status — sets the status of the spec with the given id and
// rewrites the leaf file containing it in the CLI's on-disk format.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { parse } from "yaml";

import { projectRoot, readStore } from "@/lib/spec-store";
import type { StoreData } from "@/lib/spec-types";
import { atomicWrite, specListYaml } from "@/lib/spec-writer";

export const dynamic = "force-dynamic";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

// Locate the leaf file containing the spec: prefer the file named after the
// id's taxonomy parts, else search every *.spec.yaml in the spec dir.
async function findLeafFile(
  id: string,
  layers: string[] | false | undefined,
): Promise<string | null> {
  const dir = path.join(projectRoot(), "spec");
  let names: string[];
  try {
    names = (await fsp.readdir(dir)).sort();
  } catch {
    return null;
  }
  const order: string[] = [];
  if (Array.isArray(layers) && layers.length > 0) {
    order.push(`${id.split("_").slice(0, layers.length).join("_")}.spec.yaml`);
  } else if (layers === false) {
    order.push("specs.spec.yaml");
  }
  for (const name of names) {
    if (name.endsWith(".spec.yaml") && !order.includes(name)) order.push(name);
  }
  for (const name of order) {
    let doc: unknown;
    try {
      doc = parse(await fsp.readFile(path.join(dir, name), "utf8"));
    } catch {
      continue;
    }
    const list = (doc as { specs?: unknown })?.specs;
    if (
      Array.isArray(list) &&
      list.some((entry) => String((entry as Record<string, unknown>).id) === id)
    ) {
      return path.join(dir, name);
    }
  }
  return null;
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
  const status = body.status;
  if (typeof id !== "string" || typeof status !== "string") {
    return NextResponse.json({ error: "invalid-body" }, { status: 400 });
  }

  let data: StoreData;
  try {
    data = await readStore();
  } catch {
    return NextResponse.json({ error: "io-error" }, { status: 500 });
  }

  const configured =
    data.config && Array.isArray(data.config.status)
      ? data.config.status.map((s) => s.name)
      : [];
  if (!configured.includes(status)) {
    return NextResponse.json({ error: "status-invalid" }, { status: 400 });
  }

  if (!data.specs.some((s) => s.id === id)) {
    return NextResponse.json({ error: "not-found" }, { status: 404 });
  }

  const file = await findLeafFile(id, data.config?.taxonomy?.layers);
  if (!file) {
    return NextResponse.json({ error: "io-error" }, { status: 500 });
  }

  let doc: unknown;
  try {
    doc = parse(await fsp.readFile(file, "utf8"));
  } catch {
    return NextResponse.json({ error: "io-error" }, { status: 500 });
  }
  const list = (doc as { specs?: unknown })?.specs;
  if (!Array.isArray(list)) {
    return NextResponse.json({ error: "io-error" }, { status: 500 });
  }

  const entries = list as Record<string, unknown>[];
  const target = entries.find((entry) => String(entry.id) === id);
  if (!target) {
    return NextResponse.json({ error: "not-found" }, { status: 404 });
  }
  // Set in place: keeps the key's position, appends it if absent.
  target.status = status;
  entries.sort((a, b) => {
    const x = String(a.id);
    const y = String(b.id);
    return x < y ? -1 : x > y ? 1 : 0;
  });

  try {
    await atomicWrite(file, specListYaml(entries));
  } catch {
    return NextResponse.json({ error: "io-error" }, { status: 500 });
  }

  return NextResponse.json({ id, status });
}
