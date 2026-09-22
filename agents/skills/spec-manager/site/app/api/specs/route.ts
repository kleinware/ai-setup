// GET /api/specs — current state of the spec store on disk.

import { NextResponse } from "next/server";

import { readStore } from "@/lib/spec-store";

export const dynamic = "force-dynamic";

export async function GET() {
  const data = await readStore();
  return NextResponse.json(data);
}
