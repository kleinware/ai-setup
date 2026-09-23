import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { parse } from "yaml";

// Hermetic site tests: every run copies the fixture spec store into a fresh
// scratch directory and launches the real launcher script against it. The
// repo's real spec/ store is never read or written by these tests.

const SKILL_DIR = resolve(import.meta.dir, "..", "..");
const LAUNCHER = join(SKILL_DIR, "spec-manage-site.sh");
const FIXTURE = join(import.meta.dir, "fixtures", "fixture-repo");

const PORT = 8080;
const URL = `http://127.0.0.1:${PORT}/`;

// Spec ids in the fixture store, already in ascending order.
const FIXTURE_IDS = [
  "app_ui_list_items-paginated",
  "app_ui_list_items-sorted",
  "app_ui_table_columns-resize",
  "tools_cli_run_flags-parsed",
  "tools_cli_run_output-stream",
];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function copyFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "spec-site-tst-"));
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

function specRowIds(page: Page): Promise<string[]> {
  return page.$$eval('[data-testid^="spec-row-"]', (els) =>
    els.map((el) => el.getAttribute("data-testid")!.slice("spec-row-".length)),
  );
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
// be this test's scratch root, not somebody else's.
async function expectServing(root: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/specs`, { cache: "no-store" });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { root?: string };
  expect(body.root).toBe(root);
}

// Expected fixture spec content, hardcoded per the fixture target state.
const SPEC_DATA: Record<
  string,
  { description: string; motivation: string; criteria: string[]; status: string }
> = {
  "app_ui_list_items-paginated": {
    description: "The list shows one page of items at a time with a pager.",
    motivation: "Large lists must stay readable, so items are paginated.",
    criteria: [
      "The pager controls which page of items is shown.",
      "Page navigation updates the visible items without reloading the page.",
    ],
    status: "pending",
  },
  "app_ui_list_items-sorted": {
    description: "List items render in stable, deterministic order.",
    motivation: "Users compare rows across reloads, so ordering must not jump.",
    criteria: ["Items keep the same relative order on every render."],
    status: "done",
  },
  "app_ui_table_columns-resize": {
    description: "Table columns can be resized by dragging their dividers.",
    motivation: "Dense data needs adjustable column widths.",
    criteria: [
      "Dragging a divider changes the column width.",
      "The resized width persists within the session.",
    ],
    status: "pending",
  },
  "tools_cli_run_flags-parsed": {
    description: "The run subcommand parses flags in single- and double-dash form.",
    motivation: "Users type flags both ways, so both must work.",
    criteria: ["Single-dash and double-dash flags parse to the same values."],
    status: "pending",
  },
  "tools_cli_run_output-stream": {
    description: "Run output streams to stdout as it is produced.",
    motivation: "Long-running commands need live progress feedback.",
    criteria: ["Output appears on stdout before the command finishes."],
    status: "done",
  },
};

test(
  "T1 [tooling_spec-manager_site_launch] launcher starts a server and GET / returns the site with 200",
  async () => {
    await withServer(async (root) => {
      const res = await fetch(URL);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/html");
      const body = await res.text();
      expect(body).toContain("Spec Manager");
      expect(body).toContain("<html");
      // the server must have been launched from a root holding spec/
      expect(root).toContain("spec");
    });
  },
  180_000,
);

test(
  "T2 [tooling_spec-manager_site_launch] running from a directory without spec/ exits non-zero with an error",
  async () => {
    const empty = mkdtempSync(join(tmpdir(), "spec-site-tst-empty-"));
    try {
      const res = spawnSync("bash", [LAUNCHER], {
        cwd: empty,
        env: { ...process.env },
        encoding: "utf-8",
        timeout: 30_000,
      });
      expect(res.status).not.toBe(0);
      expect(res.stderr ?? "").toMatch(/spec/);
    } finally {
      cleanup(empty);
    }
  },
  60_000,
);

test(
  "T3 [tooling_spec-manager_site_live-data] the page shows every spec id from the fixture leaf files",
  async () => {
    await withServer(async () => {
      const page = await openPage();
      try {
        const ids = (await specRowIds(page)).sort();
        expect(ids).toEqual([...FIXTURE_IDS].sort());
        for (const id of FIXTURE_IDS) {
          expect(await page.locator(`[data-testid="spec-row-${id}"]`).count()).toBe(1);
        }
        // a spot-check that real spec content, not just ids, is rendered
        const row = page.locator('[data-testid="spec-row-app_ui_list_items-sorted"]');
        expect(await row.textContent()).toContain("stable, deterministic order");
      } finally {
        await page.close();
      }
    });
  },
  180_000,
);

test(
  "T4 [tooling_spec-manager_site_live-data] follow-up notes from spec_follow_up.yaml are displayed",
  async () => {
    await withServer(async () => {
      const page = await openPage();
      try {
        const note = page.locator('[data-testid="follow-up-app_ui_list_items-paginated"]');
        expect(await note.count()).toBe(1);
        const text = (await note.textContent()) ?? "";
        expect(text).toContain("The pager must keep the active page across data refreshes.");
        expect(text).toContain("Live updates must not lose the user's place in the list.");
        expect(text).toContain("The active page index is preserved when new data arrives.");
        expect(text).toContain("The pager highlights the active page number.");

        const note2 = page.locator('[data-testid="follow-up-tools_cli_run_flags-parsed"]');
        expect(await note2.count()).toBe(1);
        expect((await note2.textContent()) ?? "").toContain(
          "Unknown flags exit non-zero and print a usage message.",
        );
      } finally {
        await page.close();
      }
    });
  },
  180_000,
);

test(
  "T5 [tooling_spec-manager_site_live-data] editing a spec file on disk updates the open page without reload",
  async () => {
    await withServer(async (root) => {
      const page = await openPage();
      try {
        const marker = "LIVE-EDIT-MARKER-42";
        const file = join(root, "spec", "app_ui_table.spec.yaml");
        const before = readFileSync(file, "utf8");
        const after = before.replace(
          "Table columns can be resized by dragging their dividers.",
          `Table columns can be resized by dragging their dividers. ${marker}`,
        );
        expect(after !== before).toBe(true);
        writeFileSync(file, after);

        await page.waitForFunction(
          (m: string) => document.body.innerText.includes(m),
          marker,
          { timeout: 15_000 },
        );
        const row = page.locator('[data-testid="spec-row-app_ui_table_columns-resize"]');
        expect(await row.textContent()).toContain(marker);
      } finally {
        await page.close();
      }
    });
  },
  180_000,
);

test(
  "T6 [tooling_spec-manager_site_grouped-view] spec ids are listed in ascending order under their taxonomy path",
  async () => {
    await withServer(async () => {
      const page = await openPage();
      try {
        // ascending order in document order
        const ids = await specRowIds(page);
        expect(ids).toEqual(FIXTURE_IDS);

        // hierarchy structure: one group per taxonomy path
        const groups = [
          "group-app",
          "group-app-ui",
          "group-app-ui-list",
          "group-app-ui-table",
          "group-tools",
          "group-tools-cli",
          "group-tools-cli-run",
        ];
        for (const g of groups) {
          expect(await page.locator(`[data-testid="${g}"]`).count()).toBe(1);
        }

        // each spec row lives under its own section group
        expect(
          await page
            .locator('[data-testid="group-app-ui-list"]')
            .locator('[data-testid="spec-row-app_ui_list_items-paginated"]')
            .count(),
        ).toBe(1);
        expect(
          await page
            .locator('[data-testid="group-app-ui-list"]')
            .locator('[data-testid="spec-row-app_ui_list_items-sorted"]')
            .count(),
        ).toBe(1);
        expect(
          await page
            .locator('[data-testid="group-app-ui-table"]')
            .locator('[data-testid="spec-row-app_ui_table_columns-resize"]')
            .count(),
        ).toBe(1);
        expect(
          await page
            .locator('[data-testid="group-tools-cli-run"]')
            .locator('[data-testid="spec-row-tools_cli_run_flags-parsed"]')
            .count(),
        ).toBe(1);
        expect(
          await page
            .locator('[data-testid="group-tools-cli-run"]')
            .locator('[data-testid="spec-row-tools_cli_run_output-stream"]')
            .count(),
        ).toBe(1);
      } finally {
        await page.close();
      }
    });
  },
  180_000,
);

test(
  "T7 [tooling_spec-manager_site_grouped-view] collapsing a layer hides the specs under it; expanding restores them",
  async () => {
    await withServer(async () => {
      const page = await openPage();
      try {
        const trigger = page.locator('[data-testid="group-app-trigger"]');
        await trigger.click();

        // all spec ids under the "app" area disappear from the DOM
        await page.waitForFunction(
          () =>
            ![...document.querySelectorAll('[data-testid^="spec-row-"]')].some(
              (el) => el.closest('[data-testid="group-app"]') !== null,
            ),
          { timeout: 10_000 },
        );
        expect(
          await page.locator('[data-testid="spec-row-app_ui_list_items-paginated"]').count(),
        ).toBe(0);
        expect(
          await page.locator('[data-testid="spec-row-app_ui_list_items-sorted"]').count(),
        ).toBe(0);
        expect(
          await page.locator('[data-testid="spec-row-app_ui_table_columns-resize"]').count(),
        ).toBe(0);
        // a sibling area stays visible
        expect(
          await page.locator('[data-testid="spec-row-tools_cli_run_flags-parsed"]').count(),
        ).toBe(1);

        // expanding restores every spec id under the layer
        await trigger.click();
        const appIds = FIXTURE_IDS.filter((id) => id.startsWith("app_"));
        await page.waitForFunction(
          (ids: string[]) =>
            ids.every((id) => document.querySelector(`[data-testid="spec-row-${id}"]`) !== null),
          appIds,
          { timeout: 10_000 },
        );
        for (const id of FIXTURE_IDS.filter((id) => id.startsWith("app_"))) {
          expect(await page.locator(`[data-testid="spec-row-${id}"]`).count()).toBe(1);
        }
      } finally {
        await page.close();
      }
    });
  },
  180_000,
);

test(
  "T8 [tooling_spec-manager_site_status-edit] each spec is its own shadcn item with id, a status radio group, description, motivation, and acceptance criteria",
  async () => {
    await withServer(async (root) => {
      await expectServing(root);
      const config = parse(readFileSync(join(root, "spec", ".config.yaml"), "utf8")) as {
        status?: Array<{ name: string; description: string }>;
      };
      const statuses = (config.status ?? []).map((s) => s.name);
      expect(statuses.length).toBeGreaterThan(0);

      const page = await openPage();
      try {
        for (const id of FIXTURE_IDS) {
          const spec = SPEC_DATA[id];

          expect(await page.locator(`[data-testid="spec-row-${id}"]`).count()).toBe(1);
          expect((await page.locator(`[data-testid="spec-id-${id}"]`).textContent())?.trim()).toBe(id);

          expect(await page.locator(`[data-testid="status-radio-${id}"]`).count()).toBe(1);
          expect(
            await page.locator(`[data-testid^="status-option-${id}-"]`).count(),
          ).toBe(statuses.length);
          for (const status of statuses) {
            expect(
              await page.locator(`[data-testid="status-option-${id}-${status}"]`).count(),
            ).toBe(1);
          }

          expect(
            (await page.locator(`[data-testid="spec-description-${id}"]`).textContent())?.trim(),
          ).toBe(spec.description);
          expect(
            (await page.locator(`[data-testid="spec-motivation-${id}"]`).textContent()) ?? "",
          ).toContain(spec.motivation);

          const criteria = page.locator(`[data-testid="spec-criteria-${id}"]`);
          expect(await criteria.count()).toBe(1);
          const criteriaText = (await criteria.textContent()) ?? "";
          for (const criterion of spec.criteria) {
            expect(criteriaText).toContain(criterion);
          }

          expect(
            await page
              .locator(`[data-testid="status-option-${id}-${spec.status}"]`)
              .getAttribute("aria-checked"),
          ).toBe("true");
        }
      } finally {
        await page.close();
      }
    });
  },
  180_000,
);

test(
  "T9 [tooling_spec-manager_site_status-edit] selecting a status in the UI writes the new status into the leaf spec.yaml and the UI shows it",
  async () => {
    const id = "tools_cli_run_flags-parsed";
    await withServer(async (root) => {
      await expectServing(root);
      const page = await openPage();
      try {
        await page.locator(`[data-testid="status-option-${id}-done"]`).click();

        await page.waitForFunction(
          (i: string) => {
            const opt = document.querySelector(`[data-testid="status-option-${i}-done"]`);
            const badge = document.querySelector(`[data-testid="spec-status-${i}"]`);
            return (
              opt !== null &&
              opt.getAttribute("aria-checked") === "true" &&
              (badge?.textContent ?? "").trim() === "done"
            );
          },
          id,
          { timeout: 15_000 },
        );

        await pollYaml(root, "spec/tools_cli_run.spec.yaml", (doc: unknown) => {
          const d = doc as { specs?: Array<Record<string, unknown>> };
          const entry = (d.specs ?? []).find((s) => s.id === id);
          return entry !== undefined && entry.status === "done";
        }, 15_000);

        const doc = parse(
          readFileSync(join(root, "spec", "tools_cli_run.spec.yaml"), "utf8"),
        ) as { specs?: Array<Record<string, unknown>> };
        const entry = (doc.specs ?? []).find((s) => s.id === id);
        expect(entry).toBeDefined();
        expect(entry!.status).toBe("done");
        expect(entry!.description).toBe(
          "The run subcommand parses flags in single- and double-dash form.",
        );
        expect(entry!.motivation).toBe("Users type flags both ways, so both must work.");
        expect(entry!.acceptance_criteria).toEqual([
          "Single-dash and double-dash flags parse to the same values.",
        ]);
        const sibling = (doc.specs ?? []).find((s) => s.id === "tools_cli_run_output-stream");
        expect(sibling).toBeDefined();
        expect(sibling!.status).toBe("done");
      } finally {
        await page.close();
      }
    });
  },
  180_000,
);

test(
  "T10 [tooling_spec-manager_site_follow-up-file] saving follow-up notes for several spec ids writes spec_follow_up.yaml with items sorted by id and exact field shape",
  async () => {
    const sortedText = "How are items re-sorted when the list is refreshed?";
    const streamText = "The stream must flush buffered output before exit.";
    await withServer(async (root) => {
      await expectServing(root);
      const page = await openPage();
      try {
        // Saving is triggered by blur (Enter only inserts a newline).
        const criterion = page.locator(
          '[data-testid="follow-up-criterion-app_ui_list_items-sorted-0"]',
        );
        await criterion.fill(sortedText);
        await criterion.blur();

        const desc = page.locator(
          '[data-testid="follow-up-desc-tools_cli_run_output-stream"]',
        );
        await desc.fill(streamText);
        await desc.blur();

        await page.waitForFunction(
          () => {
            const a = document.querySelector(
              '[data-testid="follow-up-indicator-criterion-app_ui_list_items-sorted-0"]',
            );
            const b = document.querySelector(
              '[data-testid="follow-up-indicator-desc-tools_cli_run_output-stream"]',
            );
            return (
              a !== null &&
              a.getAttribute("data-state") === "saved" &&
              b !== null &&
              b.getAttribute("data-state") === "saved"
            );
          },
          { timeout: 15_000 },
        );

        await pollFollowUp(
          root,
          (doc) => JSON.stringify(doc.items ?? []).includes(sortedText) &&
            JSON.stringify(doc.items ?? []).includes(streamText),
          15_000,
        );

        const doc = parseFollowUpFile(root);
        const items = doc.items ?? [];
        expect(items.length).toBe(4);
        expect(items.map((it) => it.id)).toEqual([
          "app_ui_list_items-paginated",
          "app_ui_list_items-sorted",
          "tools_cli_run_flags-parsed",
          "tools_cli_run_output-stream",
        ]);

        const sorted = fuItem(doc, "app_ui_list_items-sorted")!;
        expect(sorted.acceptance_criteria).toEqual({ 0: sortedText });
        expect(Object.keys(sorted).sort()).toEqual(["acceptance_criteria", "id"]);
        expect("description" in sorted).toBe(false);
        expect("motivation" in sorted).toBe(false);

        const stream = fuItem(doc, "tools_cli_run_output-stream")!;
        expect(stream.description).toBe(streamText);
        expect("motivation" in stream).toBe(false);
        expect("acceptance_criteria" in stream).toBe(false);

        const paginated = fuItem(doc, "app_ui_list_items-paginated")!;
        expect(paginated.description).toBe(
          "The pager must keep the active page across data refreshes.",
        );
        expect(paginated.motivation).toBe(
          "Live updates must not lose the user's place in the list.",
        );
        expect(paginated.acceptance_criteria).toEqual({
          0: "The active page index is preserved when new data arrives.",
          1: "The pager highlights the active page number.",
        });

        const flags = fuItem(doc, "tools_cli_run_flags-parsed")!;
        expect(flags.description).toBe(
          "Flag parsing must reject unknown flags with a usage hint.",
        );
        expect("motivation" in flags).toBe(false);
        expect(flags.acceptance_criteria).toEqual({
          0: "Unknown flags exit non-zero and print a usage message.",
        });
      } finally {
        await page.close();
      }
    });
  },
  180_000,
);

test(
  "T11 [tooling_spec-manager_site_follow-up-notes] typing shows a yellow pending indicator; saving writes spec_follow_up.yaml and turns the indicator green",
  async () => {
    const id = "app_ui_table_columns-resize";
    // multi-line: tall enough to grow the textarea past its min-height
    const text =
      "Does resizing persist across reloads?\nAnd across browser tabs?\nAnd across window resizes?";
    await withServer(async (root) => {
      await expectServing(root);
      const page = await openPage();
      try {
        const field = page.locator(`[data-testid="follow-up-desc-${id}"]`);
        const emptyHeight = (await field.boundingBox())!.height;
        await field.fill(text);

        // while typing, the indicator is the yellow pending dot
        await page.waitForFunction(
          (tid: string) => {
            const el = document.querySelector(`[data-testid="${tid}"]`);
            return (
              el !== null &&
              el.getAttribute("data-state") === "pending" &&
              (el.getAttribute("class") ?? "").includes("bg-yellow-400")
            );
          },
          `follow-up-indicator-desc-${id}`,
          { timeout: 10_000 },
        );

        // Enter inserts a newline; it does NOT save
        await page.keyboard.press("Enter");
        expect(await field.inputValue()).toBe(`${text}\n`);
        // the textarea grows vertically to fit the extra line
        await page.waitForFunction(
          (min: number) => {
            const el = document.querySelector(
              `[data-testid="follow-up-desc-${id}"]`,
            );
            return el !== null && el.getBoundingClientRect().height > min;
          },
          emptyHeight,
          { timeout: 10_000 },
        );
        // still pending, and nothing has been written to disk yet
        await page.waitForFunction(
          (tid: string) => {
            const el = document.querySelector(`[data-testid="${tid}"]`);
            return el !== null && el.getAttribute("data-state") === "pending";
          },
          `follow-up-indicator-desc-${id}`,
          { timeout: 10_000 },
        );
        let written = false;
        try {
          const early = parseFollowUpFile(root);
          const item = fuItem(early, id);
          written = item !== undefined && item.description === `${text}\n`;
        } catch {
          written = false;
        }
        expect(written).toBe(false);

        // blur saves: the indicator turns green and the file carries the text
        await field.blur();
        await page.waitForFunction(
          (tid: string) => {
            const el = document.querySelector(`[data-testid="${tid}"]`);
            return (
              el !== null &&
              el.getAttribute("data-state") === "saved" &&
              (el.getAttribute("class") ?? "").includes("text-green-600")
            );
          },
          `follow-up-indicator-desc-${id}`,
          { timeout: 15_000 },
        );

        await pollFollowUp(
          root,
          (doc) => {
            const item = fuItem(doc, id);
            return item !== undefined && item.description === `${text}\n`;
          },
          15_000,
        );
      } finally {
        await page.close();
      }
    });
  },
  180_000,
);

test(
  "T12 [tooling_spec-manager_site_follow-up-notes] 5 seconds of inactivity auto-saves and shows the green checkmark",
  async () => {
    const id = "tools_cli_run_flags-parsed";
    const text = "Why not also document the double-dash behavior?";
    await withServer(async (root) => {
      await expectServing(root);
      const page = await openPage();
      try {
        await page.locator(`[data-testid="follow-up-motivation-${id}"]`).fill(text);

        await page.waitForFunction(
          (tid: string) => {
            const el = document.querySelector(`[data-testid="${tid}"]`);
            return el !== null && el.getAttribute("data-state") === "pending";
          },
          `follow-up-indicator-motivation-${id}`,
          { timeout: 10_000 },
        );

        // stop interacting; the 5s inactivity timer should auto-save
        await sleep(6000);

        await page.waitForFunction(
          (tid: string) => {
            const el = document.querySelector(`[data-testid="${tid}"]`);
            return (
              el !== null &&
              el.getAttribute("data-state") === "saved" &&
              (el.getAttribute("class") ?? "").includes("text-green-600")
            );
          },
          `follow-up-indicator-motivation-${id}`,
          { timeout: 10_000 },
        );

        await pollFollowUp(
          root,
          (doc) => {
            const item = fuItem(doc, id);
            return item !== undefined && item.motivation === text;
          },
          15_000,
        );
      } finally {
        await page.close();
      }
    });
  },
  180_000,
);

test(
  "T13 [tooling_spec-manager_site_follow-up-notes] clearing a textarea removes the field; clearing all fields leaves an id-only item",
  async () => {
    const id = "app_ui_list_items-paginated";
    await withServer(async (root) => {
      await expectServing(root);
      const page = await openPage();
      try {
        // Saving is triggered by blur (Enter only inserts a newline).
        const clearField = async (testId: string) => {
          const field = page.locator(`[data-testid="${testId}"]`);
          await field.fill("");
          await field.blur();
        };

        await clearField(`follow-up-criterion-${id}-0`);
        await pollFollowUp(
          root,
          (doc) => {
            const item = fuItem(doc, id);
            if (item === undefined) return false;
            const crit = (item.acceptance_criteria ?? {}) as Record<string, string>;
            return (
              !("0" in crit) &&
              crit["1"] === "The pager highlights the active page number." &&
              item.description === "The pager must keep the active page across data refreshes." &&
              item.motivation === "Live updates must not lose the user's place in the list."
            );
          },
          15_000,
        );

        await clearField(`follow-up-desc-${id}`);
        await pollFollowUp(
          root,
          (doc) => {
            const item = fuItem(doc, id);
            if (item === undefined) return false;
            const crit = (item.acceptance_criteria ?? {}) as Record<string, string>;
            return (
              !("description" in item) &&
              item.motivation === "Live updates must not lose the user's place in the list." &&
              crit["1"] === "The pager highlights the active page number."
            );
          },
          15_000,
        );

        await clearField(`follow-up-motivation-${id}`);
        await pollFollowUp(
          root,
          (doc) => {
            const item = fuItem(doc, id);
            if (item === undefined) return false;
            return (
              !("motivation" in item) &&
              !("description" in item) &&
              JSON.stringify(item.acceptance_criteria ?? {}).includes(
                "The pager highlights the active page number.",
              )
            );
          },
          15_000,
        );

        await clearField(`follow-up-criterion-${id}-1`);
        const doc = await pollFollowUp(
          root,
          (d) => {
            const item = fuItem(d, id);
            return item !== undefined && Object.keys(item).length === 1 && item.id === id;
          },
          15_000,
        );

        const items = doc.items ?? [];
        expect(items.length).toBeGreaterThan(0);
        expect(items.map((it) => it.id)).toEqual([
          "app_ui_list_items-paginated",
          "tools_cli_run_flags-parsed",
        ]);
        const final = fuItem(doc, id)!;
        expect(Object.keys(final)).toEqual(["id"]);
        const flags = fuItem(doc, "tools_cli_run_flags-parsed")!;
        expect(flags.description).toBe(
          "Flag parsing must reject unknown flags with a usage hint.",
        );
        expect(flags.acceptance_criteria).toEqual({
          0: "Unknown flags exit non-zero and print a usage message.",
        });
        expect("motivation" in flags).toBe(false);
      } finally {
        await page.close();
      }
    });
  },
  180_000,
);

// --- Spike: tooling_spec-manager_site_filters (T14-T17) -------------------

// Click a filter select's trigger, wait for the popup to open, click the
// option, and wait for the popup to close (aria-expanded back to false).
async function selectFilter(
  page: Page,
  triggerTestId: string,
  optionTestId: string,
): Promise<void> {
  await page.locator(`[data-testid="${triggerTestId}"]`).click();
  const option = page.locator(`[data-testid="${optionTestId}"]`);
  await option.waitFor({ state: "visible", timeout: 10_000 });
  await option.click();
  await page.waitForFunction(
    (tid: string) => {
      const t = document.querySelector(`[data-testid="${tid}"]`);
      return t !== null && t.getAttribute("aria-expanded") === "false";
    },
    triggerTestId,
    { timeout: 10_000 },
  );
}

// Poll until exactly the expected spec ids are present as rows in the DOM.
async function waitForRowIds(
  page: Page,
  expected: string[],
  timeoutMs = 15_000,
): Promise<void> {
  await page.waitForFunction(
    (exp: string[]) => {
      const actual = [...document.querySelectorAll('[data-testid^="spec-row-"]')]
        .map((el) => el.getAttribute("data-testid")!.slice("spec-row-".length))
        .sort();
      return JSON.stringify(actual) === JSON.stringify([...exp].sort());
    },
    expected,
    { timeout: timeoutMs },
  );
}

test(
  "T14 [tooling_spec-manager_site_filters] filtering by status leaves only specs carrying that status",
  async () => {
    await withServer(async (root) => {
      await expectServing(root);
      const page = await openPage();
      try {
        await waitForRowIds(page, FIXTURE_IDS);

        // status=pending: only the three pending specs remain
        await selectFilter(page, "filter-status", "filter-status-option-pending");
        await waitForRowIds(page, [
          "app_ui_list_items-paginated",
          "app_ui_table_columns-resize",
          "tools_cli_run_flags-parsed",
        ]);
        for (const id of ["app_ui_list_items-sorted", "tools_cli_run_output-stream"]) {
          expect(await page.locator(`[data-testid="spec-row-${id}"]`).count()).toBe(0);
        }

        // live updates still work while a filter is active: editing a pending
        // spec's description on disk updates its visible row in place
        const marker = "FILTER-LIVE-MARKER-7";
        const file = join(root, "spec", "tools_cli_run.spec.yaml");
        const before = readFileSync(file, "utf8");
        const after = before.replace(
          "The run subcommand parses flags in single- and double-dash form.",
          `The run subcommand parses flags in single- and double-dash form. ${marker}`,
        );
        expect(after !== before).toBe(true);
        writeFileSync(file, after);
        await page.waitForFunction(
          (m: string) => document.body.innerText.includes(m),
          marker,
          { timeout: 15_000 },
        );
        const row = page.locator('[data-testid="spec-row-tools_cli_run_flags-parsed"]');
        expect((await row.textContent()) ?? "").toContain(marker);
        // the filtered set is unchanged by the update
        await waitForRowIds(page, [
          "app_ui_list_items-paginated",
          "app_ui_table_columns-resize",
          "tools_cli_run_flags-parsed",
        ]);

        // switching to status=done shows exactly the done specs
        await selectFilter(page, "filter-status", "filter-status-option-done");
        await waitForRowIds(page, [
          "app_ui_list_items-sorted",
          "tools_cli_run_output-stream",
        ]);
      } finally {
        await page.close();
      }
    });
  },
  180_000,
);

test(
  "T15 [tooling_spec-manager_site_filters] filtering by taxonomy value leaves only specs within that taxonomy branch",
  async () => {
    await withServer(async () => {
      const page = await openPage();
      try {
        await waitForRowIds(page, FIXTURE_IDS);

        // component branch app/ui: only the specs under app/ui remain
        await selectFilter(page, "filter-taxonomy", "filter-taxonomy-option-app-ui");
        await waitForRowIds(page, [
          "app_ui_list_items-paginated",
          "app_ui_list_items-sorted",
          "app_ui_table_columns-resize",
        ]);
        for (const id of ["tools_cli_run_flags-parsed", "tools_cli_run_output-stream"]) {
          expect(await page.locator(`[data-testid="spec-row-${id}"]`).count()).toBe(0);
        }
        // the whole sibling branch is removed from the DOM
        expect(await page.locator('[data-testid="group-tools"]').count()).toBe(0);
        // the group badge reflects the filtered count
        expect(
          (await page.locator('[data-testid="group-app"]').textContent()) ?? "",
        ).toContain("3");

        // a deeper section branch from the other area
        await selectFilter(page, "filter-taxonomy", "filter-taxonomy-option-tools-cli-run");
        await waitForRowIds(page, [
          "tools_cli_run_flags-parsed",
          "tools_cli_run_output-stream",
        ]);
        expect(await page.locator('[data-testid="group-app"]').count()).toBe(0);
      } finally {
        await page.close();
      }
    });
  },
  180_000,
);

test(
  "T16 [tooling_spec-manager_site_filters] a text query leaves only specs whose id, description, motivation, or a criterion contains it, case-insensitively",
  async () => {
    await withServer(async () => {
      const page = await openPage();
      try {
        // uppercase query matching description + criterion text of one spec
        await page.locator('[data-testid="filter-text"]').fill("PAGER");
        await waitForRowIds(page, ["app_ui_list_items-paginated"]);
        const row = page.locator('[data-testid="spec-row-app_ui_list_items-paginated"]');
        expect((await row.textContent()) ?? "").toContain("with a pager");
        for (const id of FIXTURE_IDS.filter((id) => id !== "app_ui_list_items-paginated")) {
          expect(await page.locator(`[data-testid="spec-row-${id}"]`).count()).toBe(0);
        }

        // mixed-case query matching a spec's id and description
        await page.locator('[data-testid="filter-text"]').fill("STREAM");
        await waitForRowIds(page, ["tools_cli_run_output-stream"]);
      } finally {
        await page.close();
      }
    });
  },
  180_000,
);

test(
  "T17 [tooling_spec-manager_site_filters] multiple filters apply together; clearing each one restores the list step by step",
  async () => {
    await withServer(async () => {
      const page = await openPage();
      try {
        await waitForRowIds(page, FIXTURE_IDS);

        // status=pending + text=pager -> only the pending spec mentioning pager
        await selectFilter(page, "filter-status", "filter-status-option-pending");
        await waitForRowIds(page, [
          "app_ui_list_items-paginated",
          "app_ui_table_columns-resize",
          "tools_cli_run_flags-parsed",
        ]);
        await page.locator('[data-testid="filter-text"]').fill("pager");
        await waitForRowIds(page, ["app_ui_list_items-paginated"]);

        // clearing the text query restores what the status filter alone yields
        await page.locator('[data-testid="filter-text"]').fill("");
        await waitForRowIds(page, [
          "app_ui_list_items-paginated",
          "app_ui_table_columns-resize",
          "tools_cli_run_flags-parsed",
        ]);

        // adding a taxonomy filter narrows to the pending app/ui specs
        await selectFilter(page, "filter-taxonomy", "filter-taxonomy-option-app-ui");
        await waitForRowIds(page, [
          "app_ui_list_items-paginated",
          "app_ui_table_columns-resize",
        ]);

        // clearing the taxonomy filter restores the pending set
        await selectFilter(page, "filter-taxonomy", "filter-taxonomy-option-all");
        await waitForRowIds(page, [
          "app_ui_list_items-paginated",
          "app_ui_table_columns-resize",
          "tools_cli_run_flags-parsed",
        ]);

        // no spec matches status=done + text=pager: rows disappear, no-match shown
        await selectFilter(page, "filter-status", "filter-status-option-done");
        await page.locator('[data-testid="filter-text"]').fill("pager");
        await page.waitForFunction(
          () =>
            document.querySelector('[data-testid="no-matches"]') !== null &&
            document.querySelectorAll('[data-testid^="spec-row-"]').length === 0,
          { timeout: 10_000 },
        );

        // clearing the text query restores the done set
        await page.locator('[data-testid="filter-text"]').fill("");
        await waitForRowIds(page, ["app_ui_list_items-sorted", "tools_cli_run_output-stream"]);

        // clearing the status filter restores the full list
        await selectFilter(page, "filter-status", "filter-status-option-all");
        await waitForRowIds(page, FIXTURE_IDS);
        expect(await page.locator('[data-testid="no-matches"]').count()).toBe(0);
      } finally {
        await page.close();
      }
    });
  },
  180_000,
);

// --- Spike: tooling_spec-manager_site_grouped-view per-spec collapse (T18) ---

test(
  "T18 [tooling_spec-manager_site_grouped-view] each spec item collapses by its id, showing only the id; it is expanded by default and siblings are unaffected",
  async () => {
    await withServer(async () => {
      const page = await openPage();
      try {
        const id = "app_ui_list_items-paginated";
        const trigger = page.locator(`[data-testid="spec-toggle-${id}"]`);
        expect(await trigger.count()).toBe(1);

        // spec items are expanded by default
        expect(await trigger.getAttribute("aria-expanded")).toBe("true");
        expect(await page.locator(`[data-testid="follow-up-${id}"]`).count()).toBe(1);

        // collapsing shows only the spec id; every detail leaves the DOM
        await trigger.click();
        await page.waitForFunction(
          (tid: string) => {
            const t = document.querySelector(`[data-testid="${tid}"]`);
            return t !== null && t.getAttribute("aria-expanded") === "false";
          },
          `spec-toggle-${id}`,
          { timeout: 10_000 },
        );
        expect(await page.locator(`[data-testid="spec-id-${id}"]`).count()).toBe(1);
        expect(await page.locator(`[data-testid="spec-status-${id}"]`).count()).toBe(0);
        expect(await page.locator(`[data-testid="follow-up-${id}"]`).count()).toBe(0);
        expect(
          await page.locator(`[data-testid="spec-description-${id}"]`).count(),
        ).toBe(0);

        // a sibling spec stays expanded with its details visible
        const siblingId = "app_ui_list_items-sorted";
        const siblingTrigger = page.locator(`[data-testid="spec-toggle-${siblingId}"]`);
        expect(await siblingTrigger.getAttribute("aria-expanded")).toBe("true");
        expect(await page.locator(`[data-testid="follow-up-${siblingId}"]`).count()).toBe(1);

        // expanding restores the details
        await trigger.click();
        await page.waitForFunction(
          (tid: string) => {
            const t = document.querySelector(`[data-testid="${tid}"]`);
            return t !== null && t.getAttribute("aria-expanded") === "true";
          },
          `spec-toggle-${id}`,
          { timeout: 10_000 },
        );
        expect(await page.locator(`[data-testid="follow-up-${id}"]`).count()).toBe(1);
        expect(await page.locator(`[data-testid="spec-status-${id}"]`).count()).toBe(1);
      } finally {
        await page.close();
      }
    });
  },
  180_000,
);

// --- Spike: tooling_spec-manager_site_filters trigger width (T19) -----------

test(
  "T19 [tooling_spec-manager_site_filters] the taxonomy trigger is sized to the longest option label; selecting that option shows its full label unclipped and filters to the branch",
  async () => {
    await withServer(async () => {
      const page = await openPage();
      try {
        // The component measures the longest option label in a hidden span
        // in the filter bar, rendered in the same font as the popup option
        // labels; that width is the ground truth for the longest label.
        const measure = page.locator('[data-testid="filter-bar"] .invisible');
        expect(await measure.count()).toBe(1);
        const longestLabel = ((await measure.textContent()) ?? "").trim();
        expect(longestLabel.length).toBeGreaterThan(0);
        const measureBox = (await measure.boundingBox())!;
        expect(measureBox.width).toBeGreaterThan(0);

        // the trigger's rendered width covers the longest label plus the
        // trigger chrome (padding + gap + icon + borders)
        const triggerBox = (
          await page.locator('[data-testid="filter-taxonomy"]').boundingBox()
        )!;
        expect(triggerBox.width).toBeGreaterThanOrEqual(measureBox.width + 38);

        // open the taxonomy dropdown and select the longest option
        await page.locator('[data-testid="filter-taxonomy"]').click();
        await page
          .locator('[data-testid="filter-taxonomy-option-all"]')
          .waitFor({ state: "visible", timeout: 10_000 });
        const options = await page.$$eval(
          '[data-testid^="filter-taxonomy-option-"]',
          (els) =>
            els.map((el) => ({
              testId: el.getAttribute("data-testid") ?? "",
              label: (el.querySelector("div")?.textContent ?? "").trim(),
            })),
        );
        expect(options.length).toBeGreaterThan(0);
        const longest = options.find((o) => o.label === longestLabel);
        if (longest === undefined) {
          throw new Error(`no taxonomy option with label "${longestLabel}"`);
        }

        // selecting the longest option shows its full label in the trigger,
        // unclipped, and filters the list to that taxonomy branch
        await page.locator(`[data-testid="${longest.testId}"]`).click();
        await page.waitForFunction(
          (tid: string) => {
            const t = document.querySelector(`[data-testid="${tid}"]`);
            return t !== null && t.getAttribute("aria-expanded") === "false";
          },
          "filter-taxonomy",
          { timeout: 10_000 },
        );

        const value = page
          .locator('[data-testid="filter-taxonomy"]')
          .locator('[data-slot="select-value"]');
        expect(((await value.textContent()) ?? "").trim()).toBe(longest.label);
        expect(
          await value.evaluate((el) => el.scrollWidth - el.clientWidth),
        ).toBeLessThanOrEqual(0.5);

        // the selected taxonomy value filters the list ("All taxonomy"
        // shows every spec)
        const expected =
          longest.label === "All taxonomy"
            ? FIXTURE_IDS
            : FIXTURE_IDS.filter((fid) =>
                fid.startsWith(longest.label.split("/").join("_") + "_"),
              );
        await waitForRowIds(page, expected);
      } finally {
        await page.close();
      }
    });
  },
  180_000,
);

// --- Spike: tooling_spec-manager_site_status-edit layout (T20) ------------

test(
  "T20 [tooling_spec-manager_site_status-edit] the status label and radio group sit directly under the spec id, left-aligned in the item; the radio still writes the leaf file and updates the UI",
  async () => {
    const id = "app_ui_list_items-paginated";
    await withServer(async (root) => {
      await expectServing(root);
      const page = await openPage();
      try {
        // the status area (label + radio group) sits directly under the id:
        // it is the first element of the item's collapsible content
        const area = page.locator(`[data-testid="spec-status-area-${id}"]`);
        expect(await area.count()).toBe(1);
        expect(
          await area.evaluate((el) => el.parentElement?.firstElementChild === el),
        ).toBe(true);
        expect(
          await area
            .locator(`[data-testid="status-radio-${id}"]`)
            .count(),
        ).toBe(1);

        // vertically below the id, left-aligned with the item's content edge
        const idBox = (await page.locator(`[data-testid="spec-id-${id}"]`).boundingBox())!;
        const itemBox = (
          await page.locator(`[data-testid="spec-row-${id}"]`).boundingBox()
        )!;
        const areaBox = (await area.boundingBox())!;
        expect(areaBox.y).toBeGreaterThanOrEqual(idBox.y + idBox.height - 1);
        expect(Math.abs(areaBox.x - (itemBox.x + 13))).toBeLessThanOrEqual(1);

        // the radio still writes the new status to the leaf file and UI
        await page.locator(`[data-testid="status-option-${id}-done"]`).click();
        await page.waitForFunction(
          (i: string) => {
            const opt = document.querySelector(`[data-testid="status-option-${i}-done"]`);
            const badge = document.querySelector(`[data-testid="spec-status-${i}"]`);
            return (
              opt !== null &&
              opt.getAttribute("aria-checked") === "true" &&
              (badge?.textContent ?? "").trim() === "done"
            );
          },
          id,
          { timeout: 15_000 },
        );
        await pollYaml(root, "spec/app_ui_list.spec.yaml", (doc: unknown) => {
          const d = doc as { specs?: Array<Record<string, unknown>> };
          const entry = (d.specs ?? []).find((s) => s.id === id);
          return entry !== undefined && entry.status === "done";
        }, 15_000);
      } finally {
        await page.close();
      }
    });
  },
  180_000,
);
