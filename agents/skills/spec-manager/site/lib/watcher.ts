// Server-side file watcher: watches the spec/ directory and notifies
// subscribers (the SSE route) shortly after any file changes.

import { watch, type FSWatcher } from "chokidar";
import path from "node:path";

import { projectRoot } from "./spec-store";

type Listener = () => void;

const listeners = new Set<Listener>();
let watcher: FSWatcher | null = null;
let debounce: ReturnType<typeof setTimeout> | null = null;

const DEBOUNCE_MS = 250;

export function onStoreUpdate(listener: Listener): () => void {
  listeners.add(listener);
  ensureWatcher();
  return () => {
    listeners.delete(listener);
  };
}

function scheduleEmit(): void {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(emit, DEBOUNCE_MS);
}

function emit(): void {
  debounce = null;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // a broken listener must not break the others
    }
  }
}

export function ensureWatcher(): void {
  if (watcher !== null) return;
  const specDir = path.join(projectRoot(), "spec");
  const w = watch(specDir, {
    ignoreInitial: true,
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });
  w.on("all", scheduleEmit);
  w.on("error", () => {
    // watching can fail (e.g. dir removed mid-session); keep serving,
    // a new /api/events connection will re-create the watcher.
    watcher = null;
  });
  watcher = w;
}

export async function closeWatcher(): Promise<void> {
  if (debounce) {
    clearTimeout(debounce);
    debounce = null;
  }
  if (watcher) {
    await watcher.close();
    watcher = null;
  }
}
