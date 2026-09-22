// Server-side writer for the spec store. Replicates the spec-manager CLI's
// YAML formatting (specListYaml) and atomic write (atomicWrite) so files
// written by the site stay byte-compatible with what the CLI produces.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { stringify } from "yaml";

// Serialize a leaf file the way the CLI's specListYaml does: stringify with
// lineWidth 100, then insert a blank line before every "  - " line except the
// first.
export function specListYaml(specs: Record<string, unknown>[]): string {
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

// Write to a temp file in the same directory, then rename (the CLI's
// atomicWrite), so readers never observe a partial file.
export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsp.writeFile(tmp, content);
    await fsp.rename(tmp, filePath);
  } catch (e) {
    await fsp.unlink(tmp).catch(() => undefined);
    throw e;
  }
}
