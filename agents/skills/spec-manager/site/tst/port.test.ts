import { expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createConnection } from "node:net";

// UAT/e2e for spec tooling_spec-manager_site_port: the launcher script's
// port handling (default 8080, --port <X>, and the Tip: line in both the
// ready and the failed-to-start output) is exercised hermetically against a
// scratch copy of the fixture repo. No browser is needed.
//
// Port 8080 may be occupied by a stale dev server left running in a dev
// pane, so T1 adapts at runtime (success or failure branch) and the other
// tests use non-default ports. A dev server left running in this site
// directory also holds Next's per-directory dist lock (site/.next/dev/lock)
// for its whole lifetime, which blocks any new `next dev` in this
// directory on ANY port; each test deletes that lock file before spawning
// so the new server can create its own (flocks are per-inode, the stale
// server keeps its own fd).

const SKILL_DIR = resolve(import.meta.dir, "..", "..");
const LAUNCHER = join(SKILL_DIR, "spec-manage-site.sh");
const FIXTURE = join(import.meta.dir, "fixtures", "fixture-repo");
const DIST_LOCK = join(SKILL_DIR, "site", ".next", "dev", "lock");

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function copyFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "spec-site-port-"));
  cpSync(join(FIXTURE, "spec"), join(root, "spec"), { recursive: true });
  return root;
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

// See file header: release a stale per-directory dist lock so a new
// `next dev` can start in this site directory.
function releaseDistLock(): void {
  rmSync(DIST_LOCK, { force: true });
}

type Launcher = {
  child: ChildProcess;
  output: { stdout: string; stderr: string };
};

function spawnLauncher(root: string, args: string[] = []): Launcher {
  const child = spawn("bash", [LAUNCHER, ...args], {
    cwd: root,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { stdout: "", stderr: "" };
  child.stdout?.on("data", (d: Buffer) => {
    output.stdout += d.toString("utf8");
  });
  child.stderr?.on("data", (d: Buffer) => {
    output.stderr += d.toString("utf8");
  });
  return { child, output };
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

// Guard against another dev server squatting the port: the served store must
// be this test's scratch root, not somebody else's.
async function expectServing(root: string, port: number): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/api/specs`, { cache: "no-store" });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { root?: string };
  expect(body.root).toBe(root);
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("error", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function findFreePort(): Promise<number> {
  for (let port = 3100; port < 3200; port++) {
    if (await portIsFree(port)) return port;
  }
  throw new Error("no free port found in 3100-3199");
}

function startDummyServer(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(() => {});
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((r) => server.close(() => r()));
}

async function pollOutput(pred: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(250);
  }
  throw new Error("timed out waiting for launcher output condition");
}

// True once stdout carries the exact URL line, followed by a Tip: line
// mentioning the --port flag.
function urlThenTip(stdout: string, port: number): boolean {
  const lines = stdout.split("\n");
  const i = lines.findIndex((l) => l.trim() === `http://127.0.0.1:${port}/`);
  if (i === -1) return false;
  return lines
    .slice(i + 1)
    .some((l) => l.startsWith("Tip:") && l.includes("--port"));
}

function tipLine(combined: string): string | undefined {
  return combined.split("\n").find((l) => l.startsWith("Tip:"));
}

// Failure-output assertions shared by the port-in-use branches: the process
// exited non-zero, the combined output names the port, and a Tip: line
// mentioning --port is present.
function assertFailedStart(launcher: Launcher, port: string): void {
  expect(launcher.child.exitCode).not.toBeNull();
  expect(launcher.child.exitCode).not.toBe(0);
  const combined = launcher.output.stdout + launcher.output.stderr;
  expect(combined).toContain(port);
  const tip = tipLine(combined);
  expect(tip).toBeDefined();
  expect(tip).toContain("--port");
}

test(
  "T1 [tooling_spec-manager_site_port] no flag: defaults to port 8080, printing the URL then a Tip line when up (or the Tip in the failure output when 8080 is occupied)",
  async () => {
    const root = copyFixture();
    const free = await portIsFree(8080);
    releaseDistLock();
    const launcher = spawnLauncher(root);
    try {
      if (free) {
        await waitForHttpOk("http://127.0.0.1:8080/", 90_000);
        await expectServing(root, 8080);
        await pollOutput(() => urlThenTip(launcher.output.stdout, 8080), 90_000);
      } else {
        await waitForExit(launcher.child, 90_000);
        assertFailedStart(launcher, "8080");
      }
    } finally {
      await stopServer(launcher.child);
      cleanup(root);
    }
  },
  180_000,
);

test(
  "T2 [tooling_spec-manager_site_port] --port 3003: starts the site on 127.0.0.1:3003 and prints the URL followed by the Tip line",
  async () => {
    const root = copyFixture();
    const free = await portIsFree(3003);
    releaseDistLock();
    const launcher = spawnLauncher(root, ["--port", "3003"]);
    try {
      if (free) {
        await waitForHttpOk("http://127.0.0.1:3003/", 90_000);
        await expectServing(root, 3003);
        await pollOutput(() => urlThenTip(launcher.output.stdout, 3003), 90_000);
      } else {
        await waitForExit(launcher.child, 90_000);
        assertFailedStart(launcher, "3003");
      }
    } finally {
      await stopServer(launcher.child);
      cleanup(root);
    }
  },
  180_000,
);

test(
  "T3 [tooling_spec-manager_site_port] port in use: the failure output includes the Tip line mentioning --port",
  async () => {
    const port = await findFreePort();
    const dummy = await startDummyServer(port);
    const root = copyFixture();
    releaseDistLock();
    const launcher = spawnLauncher(root, ["--port", String(port)]);
    try {
      await waitForExit(launcher.child, 90_000);
      assertFailedStart(launcher, String(port));
    } finally {
      await stopServer(launcher.child);
      await closeServer(dummy);
      cleanup(root);
    }
  },
  180_000,
);

test(
  "T4 [tooling_spec-manager_site_port] unknown flag exits 2 with a usage message mentioning --port; --port with no value exits 2",
  async () => {
    const empty = mkdtempSync(join(tmpdir(), "spec-site-port-empty-"));
    try {
      const res = spawnSync("bash", [LAUNCHER, "--bogus"], {
        cwd: empty,
        env: { ...process.env },
        encoding: "utf-8",
        timeout: 30_000,
      });
      expect(res.status).toBe(2);
      const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
      expect(out).toContain("usage: spec-manage-site.sh [--port <X>]");

      const res2 = spawnSync("bash", [LAUNCHER, "--port"], {
        cwd: empty,
        env: { ...process.env },
        encoding: "utf-8",
        timeout: 30_000,
      });
      expect(res2.status).toBe(2);
      const out2 = `${res2.stdout ?? ""}${res2.stderr ?? ""}`;
      expect(out2).toContain("--port");
    } finally {
      cleanup(empty);
    }
  },
  60_000,
);
