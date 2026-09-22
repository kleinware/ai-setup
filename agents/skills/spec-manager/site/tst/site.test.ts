import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";

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
