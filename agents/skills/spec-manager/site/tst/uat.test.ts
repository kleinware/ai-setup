import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { parse } from "yaml";

// UAT (user acceptance tests) for the spec-manager site — spec
// tooling_spec-manager_site_uat.
//
// The UAT drives the real site like a user through a headless browser,
// against a throwaway "test repo": the checked-in UAT fixture store
// (site/tst/fixtures/uat-repo/spec/) is copied into a fresh scratch
// directory per run, spec-manage-site.sh is launched against that scratch
// directory, and every change the UI makes is asserted on disk in that
// scratch repo. The checked-in fixture and the repo's real spec/ store are
// never read or written here.

const SKILL_DIR = resolve(import.meta.dir, "..", "..");
const LAUNCHER = join(SKILL_DIR, "spec-manage-site.sh");
const FIXTURE = join(import.meta.dir, "fixtures", "uat-repo");

const PORT = 8080;
const URL = `http://127.0.0.1:${PORT}/`;

// Spec ids in the UAT fixture store, in ascending order.
const UAT_IDS = [
  "tools_cli_run_flags-parsed",
  "tools_cli_run_output-stream",
  "web_ui_list_rows-paginated",
  "web_ui_list_rows-sorted",
  "web_ui_table_grid-resize",
];

// The spec ids the journey touches, in the sorted order the on-disk
// spec_follow_up.yaml must carry them in.
const STATUS_ID = "web_ui_list_rows-paginated"; // fixture status: pending
const NOTE_IDS = ["tools_cli_run_flags-parsed", "web_ui_list_rows-paginated"];

// The exact text typed into the UI; must appear verbatim on disk.
const DESC_TEXT = "UAT: the pager must keep the active page when data refreshes.";
const CRIT_TEXT = "UAT: the active page index is preserved when new data arrives.";
const MOT_TEXT = "UAT: unknown flags must exit non-zero with a usage hint.";

// Deterministic settle after each UI-triggered write: the store watcher
// debounces (250 ms) before emitting an SSE update, the client then refetches
// and re-renders. Waiting well past that round trip guarantees the previous
// save is on disk, its refresh is applied, and no in-flight stale store
// snapshot can clobber the next edit's fields.
const SETTLE_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function copyFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "spec-site-uat-"));
  cpSync(join(FIXTURE, "spec"), join(root, "spec"), { recursive: true });
  return root;
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

function spawnLauncher(root: string): ChildProcess {
  const child = spawn("bash", [LAUNCHER], {
    cwd: root,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.resume();
  child.stderr?.resume();
  return child;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(() => r(), timeoutMs);
    child.once("exit", () => {
      clearTimeout(t);
      r();
    });
  });
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await waitForExit(child, 15_000);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await waitForExit(child, 5_000);
  }
}

async function waitForHttpOk(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status === 200) return;
      lastError = new Error(`unexpected status ${res.status}`);
      await res.body?.cancel();
    } catch (e) {
      lastError = e;
    }
    await sleep(1000);
  }
  throw new Error(`server did not become ready at ${url}: ${String(lastError)}`);
}

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

async function withServer(fn: (root: string) => Promise<void>): Promise<void> {
  const root = copyFixture();
  const child = spawnLauncher(root);
  try {
    await waitForHttpOk(URL, 90_000);
    await fn(root);
  } finally {
    await stopServer(child);
    cleanup(root);
  }
}

async function openPage(): Promise<Page> {
  const page = await browser.newPage();
  page.setDefaultTimeout(30_000);
  await page.goto(URL);
  // Wait for the client-side fetch to finish and at least one spec row to render.
  await page.waitForSelector('[data-testid^="spec-row-"]', { timeout: 90_000 });
  return page;
}

type FollowUpDoc = { items?: Array<Record<string, unknown>> };

function fuItem(doc: FollowUpDoc, id: string): Record<string, unknown> | undefined {
  return (doc.items ?? []).find((it) => it.id === id);
}

function parseFollowUpFile(root: string): FollowUpDoc {
  return parse(readFileSync(join(root, "spec", "spec_follow_up.yaml"), "utf8")) as FollowUpDoc;
}

async function pollFollowUp(
  root: string,
  pred: (doc: FollowUpDoc) => boolean,
  timeoutMs: number,
): Promise<FollowUpDoc> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const doc = parseFollowUpFile(root);
      if (pred(doc)) return doc;
    } catch (e) {
      lastErr = e;
    }
    await sleep(500);
  }
  throw new Error(`spec_follow_up.yaml never satisfied predicate: ${String(lastErr)}`);
}

async function pollYaml(
  root: string,
  file: string,
  pred: (doc: unknown) => boolean,
  timeoutMs: number,
): Promise<unknown> {
  const path = join(root, file);
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const doc = parse(readFileSync(path, "utf8"));
      if (pred(doc)) return doc;
    } catch (e) {
      lastErr = e;
    }
    await sleep(500);
  }
  throw new Error(`YAML file ${file} never satisfied predicate: ${String(lastErr)}`);
}

// Guard against another dev server squatting the port: the served store must
// be this test's scratch root, not somebody else's (or the repo's real spec/).
async function expectServing(root: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/specs`, { cache: "no-store" });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { root?: string };
  expect(body.root).toBe(root);
}

describe("UAT [tooling_spec-manager_site_uat]", () => {
  test(
    "full user journey: a status changed and follow-up notes typed in the UI land on disk in the test repo",
    async () => {
      await withServer(async (root) => {
        // The test repo starts without spec_follow_up.yaml: the UI must
        // create it, and only in this scratch root.
        expect(existsSync(join(root, "spec", "spec_follow_up.yaml"))).toBe(false);
        await expectServing(root);

        const page = await openPage();
        try {
          // Load the site and wait for the store to render: every fixture
          // spec id is visible.
          for (const id of UAT_IDS) {
            expect(await page.locator(`[data-testid="spec-row-${id}"]`).count()).toBe(1);
          }

          // --- Step 1: change a spec's status through the status radio ---
          // STATUS_ID is "pending" in the fixture; select "done".
          await page.locator(`[data-testid="status-option-${STATUS_ID}-done"]`).click();

          // The UI reflects the change (checked radio + status badge).
          await page.waitForFunction(
            (id: string) => {
              const opt = document.querySelector(`[data-testid="status-option-${id}-done"]`);
              const badge = document.querySelector(`[data-testid="spec-status-${id}"]`);
              return (
                opt !== null &&
                opt.getAttribute("aria-checked") === "true" &&
                (badge?.textContent ?? "").trim() === "done"
              );
            },
            STATUS_ID,
            { timeout: 15_000 },
          );

          // On-disk assertion: the leaf file in the test repo now carries the
          // new status.
          await pollYaml(root, "spec/web_ui_list.spec.yaml", (doc: unknown) => {
            const d = doc as { specs?: Array<Record<string, unknown>> };
            return (d.specs ?? []).some((s) => s.id === STATUS_ID && s.status === "done");
          }, 15_000);

          const leaf = parse(
            readFileSync(join(root, "spec", "web_ui_list.spec.yaml"), "utf8"),
          ) as { specs?: Array<Record<string, unknown>> };
          const entries = leaf.specs ?? [];
          expect(entries.length).toBe(2);
          const entry = entries.find((s) => s.id === STATUS_ID)!;
          // A valid spec entry with the new status, other fields intact.
          expect(entry.status).toBe("done");
          expect(entry.description).toBe(
            "The list shows one page of rows at a time with a pager.",
          );
          expect(entry.motivation).toBe(
            "Large lists must stay readable, so rows are paginated.",
          );
          expect(entry.acceptance_criteria).toEqual([
            "The pager controls which page of rows is shown.",
            "Page navigation updates the visible rows without reloading the page.",
          ]);
          const sibling = entries.find((s) => s.id === "web_ui_list_rows-sorted")!;
          expect(sibling.status).toBe("done"); // untouched by the edit

          // Settle so the status write's refresh (a store snapshot without any
          // follow-up notes) is fully applied before the note edits begin.
          await sleep(SETTLE_MS);

          // --- Step 2: type follow-up text into fields of two spec ids ---
          // web_ui_list_rows-paginated: description + acceptance criterion 0;
          // tools_cli_run_flags-parsed: motivation. Each save is triggered
          // deterministically by pressing Enter in the focused textarea and
          // waiting for that field's indicator to turn saved.
          const typeAndSave = async (fieldTestId: string, text: string, indicatorTestId: string) => {
            await page.locator(`[data-testid="${fieldTestId}"]`).fill(text);
            await page.keyboard.press("Enter");
            await page.waitForFunction(
              (tid: string) => {
                const el = document.querySelector(`[data-testid="${tid}"]`);
                return el !== null && el.getAttribute("data-state") === "saved";
              },
              indicatorTestId,
              { timeout: 15_000 },
            );
          };

          await typeAndSave(
            `follow-up-desc-${STATUS_ID}`,
            DESC_TEXT,
            `follow-up-indicator-desc-${STATUS_ID}`,
          );
          // Settle so this save's refresh is applied before the next edit.
          await sleep(SETTLE_MS);
          await typeAndSave(
            `follow-up-criterion-${STATUS_ID}-0`,
            CRIT_TEXT,
            `follow-up-indicator-criterion-${STATUS_ID}-0`,
          );
          // Settle so this save's refresh is applied before the next edit.
          await sleep(SETTLE_MS);
          await typeAndSave(
            "follow-up-motivation-tools_cli_run_flags-parsed",
            MOT_TEXT,
            "follow-up-indicator-motivation-tools_cli_run_flags-parsed",
          );
          // Settle so the last save's refresh is applied before the final
          // on-disk and UI reflection checks.
          await sleep(SETTLE_MS);

          // --- Step 3: assert spec_follow_up.yaml in the test repo on disk ---
          await pollFollowUp(
            root,
            (doc) => {
              const items = doc.items ?? [];
              const joined = JSON.stringify(items);
              return (
                items.length === NOTE_IDS.length &&
                NOTE_IDS.every((id) => items.some((it) => it.id === id)) &&
                joined.includes(DESC_TEXT) &&
                joined.includes(CRIT_TEXT) &&
                joined.includes(MOT_TEXT)
              );
            },
            15_000,
          );

          const doc = parseFollowUpFile(root);
          const items = doc.items ?? [];
          // One item per touched spec id, items sorted by id.
          expect(items.map((it) => it.id)).toEqual(NOTE_IDS);

          const paginated = fuItem(doc, "web_ui_list_rows-paginated")!;
          expect(paginated.description).toBe(DESC_TEXT);
          expect(paginated.acceptance_criteria).toEqual({ 0: CRIT_TEXT });
          expect("motivation" in paginated).toBe(false);

          const flags = fuItem(doc, "tools_cli_run_flags-parsed")!;
          expect(flags.motivation).toBe(MOT_TEXT);
          expect("description" in flags).toBe(false);
          expect("acceptance_criteria" in flags).toBe(false);

          // The UI reflects the saved notes: green saved indicators and the
          // typed text in the fields.
          for (const indicator of [
            `follow-up-indicator-desc-${STATUS_ID}`,
            `follow-up-indicator-criterion-${STATUS_ID}-0`,
            "follow-up-indicator-motivation-tools_cli_run_flags-parsed",
          ]) {
            expect(
              await page.locator(`[data-testid="${indicator}"]`).getAttribute("data-state"),
            ).toBe("saved");
          }
          expect(
            await page.locator(`[data-testid="follow-up-desc-${STATUS_ID}"]`).inputValue(),
          ).toBe(DESC_TEXT);
        } finally {
          await page.close();
        }
      });
    },
    180_000,
  );
});
