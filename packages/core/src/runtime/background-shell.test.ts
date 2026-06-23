import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundShellManager } from "./background-shell.js";
import { notificationQueue } from "../tool-system/builtin/agent-notifications.js";
import { groupAlive } from "./spawn-common.js";

let home: string;
let mgr: BackgroundShellManager;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bgshell-home-"));
  process.env.CODE_SHELL_HOME = home;
  mgr = new BackgroundShellManager();
  notificationQueue.reset();
});

afterEach(async () => {
  await mgr.killAll();
  rmSync(home, { recursive: true, force: true });
  delete process.env.CODE_SHELL_HOME;
  notificationQueue.reset();
});

// Small helper to wait until a predicate is true (polling) or time out.
async function until(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("until() timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("spawnBackground + readOutput + exit notification", () => {
  test("short command: returns shellId, captures output, exits with notification", async () => {
    const r = mgr.spawnBackground({
      command: "echo hi; sleep 0.1",
      cwd: home,
      sessionId: "sessA",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const id = r.shellId;
    expect(id).toMatch(/^bg_/);

    await until(() => mgr.get(id)?.status === "exited");
    const out = mgr.readOutput(id, "all");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.text).toContain("hi");

    const notifs = notificationQueue.getSnapshot("sessA");
    expect(notifs.length).toBe(1);
    expect(notifs[0].description).toContain("echo hi");
  });
});

describe("incremental cursor", () => {
  test("two incremental reads don't repeat; all returns full", async () => {
    const r = mgr.spawnBackground({
      command: "echo one; sleep 0.3; echo two; sleep 0.1",
      cwd: home,
      sessionId: "sessA",
    });
    if (!r.ok) throw new Error("spawn failed");
    const id = r.shellId;

    await until(() => (mgr.readOutputRaw(id) ?? "").includes("one"));
    const first = mgr.readOutput(id, "incremental");
    expect(first.ok && first.text.includes("one")).toBe(true);

    await until(() => (mgr.readOutputRaw(id) ?? "").includes("two"));
    const second = mgr.readOutput(id, "incremental");
    expect(second.ok && second.text.includes("two")).toBe(true);
    expect(second.ok && second.text.includes("one")).toBe(false); // not repeated

    const all = mgr.readOutput(id, "all");
    expect(all.ok && all.text.includes("one") && all.text.includes("two")).toBe(true);
  });
});

describe("incremental read after disk wraparound (regression)", () => {
  test("never loses new output when the 8MB-style ring wraps", async () => {
    // Use a real shell that emits two distinct chunks with a gap; we can't
    // shrink the 8MB cap from here, so this asserts the absolute-cursor
    // contract end-to-end: two incremental reads return disjoint, complete
    // output. (RingFile's own wraparound math is unit-tested separately.)
    const r = mgr.spawnBackground({
      command: "echo AAA; sleep 0.3; echo BBB; sleep 0.1",
      cwd: home,
      sessionId: "sessA",
    });
    if (!r.ok) throw new Error("spawn failed");
    await until(() => (mgr.readOutputRaw(r.shellId) ?? "").includes("AAA"));
    const a = mgr.readOutput(r.shellId, "incremental");
    expect(a.ok && a.text.includes("AAA")).toBe(true);
    await until(() => (mgr.readOutputRaw(r.shellId) ?? "").includes("BBB"));
    const b = mgr.readOutput(r.shellId, "incremental");
    expect(b.ok && b.text.includes("BBB")).toBe(true);
    expect(b.ok && b.text.includes("AAA")).toBe(false);
  });
});

describe("ANSI cleaning in readOutput", () => {
  test("strips color and folds progress", async () => {
    const r = mgr.spawnBackground({
      command: "printf '\\033[31mred\\033[0m\\n'; sleep 0.1",
      cwd: home,
      sessionId: "sessA",
    });
    if (!r.ok) throw new Error("spawn failed");
    await until(() => mgr.get(r.shellId)?.status === "exited");
    const out = mgr.readOutput(r.shellId, "all");
    expect(out.ok && out.text.includes("red")).toBe(true);
    expect(out.ok && out.text.includes("\x1b[31m")).toBe(false);
  });
});

describe("port detection", () => {
  test("detects localhost:PORT in output", async () => {
    const r = mgr.spawnBackground({
      command: "echo 'Local: http://localhost:5173/'; sleep 0.2",
      cwd: home,
      sessionId: "sessA",
    });
    if (!r.ok) throw new Error("spawn failed");
    await until(() => mgr.get(r.shellId)?.detectedPort === 5173);
    const list = mgr.listForSession("sessA");
    expect(list.find((s) => s.shellId === r.shellId)?.detectedPort).toBe(5173);
  });
});

describe("process group kill (难点2)", () => {
  test("KillShell reaps the whole group", async () => {
    const r = mgr.spawnBackground({
      command: "sleep 100 & sleep 100 & wait",
      cwd: home,
      sessionId: "sessA",
    });
    if (!r.ok) throw new Error("spawn failed");
    const pgid = mgr.get(r.shellId)!.pgid;
    await new Promise((res) => setTimeout(res, 200));
    expect(groupAlive(pgid)).toBe(true);

    const killed = await mgr.kill(r.shellId);
    expect(killed.ok).toBe(true);
    await new Promise((res) => setTimeout(res, 100));
    expect(groupAlive(pgid)).toBe(false);
    expect(mgr.get(r.shellId)?.status).toBe("killed");
  });

  test("kill is idempotent on already-exited shell", async () => {
    const r = mgr.spawnBackground({ command: "true", cwd: home, sessionId: "sessA" });
    if (!r.ok) throw new Error("spawn failed");
    await until(() => mgr.get(r.shellId)?.status === "exited");
    const k = await mgr.kill(r.shellId);
    expect(k.ok).toBe(true);
    if (k.ok) expect(k.alreadyExited).toBe(true);
  });
});

describe("session isolation", () => {
  test("shell in session A not visible/readable from session B", async () => {
    const r = mgr.spawnBackground({ command: "sleep 1", cwd: home, sessionId: "sessA" });
    if (!r.ok) throw new Error("spawn failed");
    expect(mgr.listForSession("sessB")).toHaveLength(0);
    const read = mgr.readOutput(r.shellId, "all", "sessB");
    expect(read.ok).toBe(false);
  });

  test("killSession only kills its own shells", async () => {
    const a = mgr.spawnBackground({ command: "sleep 100", cwd: home, sessionId: "sessA" });
    const b = mgr.spawnBackground({ command: "sleep 100", cwd: home, sessionId: "sessB" });
    if (!a.ok || !b.ok) throw new Error("spawn failed");
    await new Promise((res) => setTimeout(res, 150));
    await mgr.killSession("sessA");
    await new Promise((res) => setTimeout(res, 100));
    expect(mgr.get(a.shellId)?.status).toBe("killed");
    expect(mgr.get(b.shellId)?.status).toBe("running");
  });
});

describe("pidfile lifecycle", () => {
  test("writes pidfile on spawn, removes on exit", async () => {
    const r = mgr.spawnBackground({ command: "sleep 100", cwd: home, sessionId: "sessA" });
    if (!r.ok) throw new Error("spawn failed");
    const dir = join(home, ".code-shell", "bg-shells", "sessA");
    const pidfile = `${r.shellId}.json`;
    await until(() => existsSync(dir) && readdirSync(dir).includes(pidfile));
    await mgr.kill(r.shellId);
    // Pidfile removed on kill; the .log is intentionally kept for external tail.
    await until(() => !readdirSync(dir).includes(pidfile));
    expect(readdirSync(dir).includes(pidfile)).toBe(false);
    expect(readdirSync(dir).includes(`${r.shellId}.log`)).toBe(true);
  });
});

describe("per-session shell cap", () => {
  test("rejects beyond the soft cap", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 16; i++) {
      const r = mgr.spawnBackground({ command: "sleep 100", cwd: home, sessionId: "capS" });
      if (r.ok) ids.push(r.shellId);
    }
    expect(ids.length).toBe(16);
    const over = mgr.spawnBackground({ command: "sleep 100", cwd: home, sessionId: "capS" });
    expect(over.ok).toBe(false);
  });
});

describe("reapOrphansFromPidfiles (难点1)", () => {
  test("dead pid → pidfile deleted; alive pid → listed orphaned", async () => {
    const { mkdirSync, writeFileSync, existsSync: exists } = await import("node:fs");
    const dir = join(home, ".code-shell", "bg-shells", "ghostS");
    mkdirSync(dir, { recursive: true });
    // A definitely-dead pid (very high, unlikely to exist).
    const deadFile = join(dir, "bg_dead.json");
    writeFileSync(
      deadFile,
      JSON.stringify({ shellId: "bg_dead", pgid: 2_000_000_000, command: "x", startedAt: 1, sessionId: "ghostS" }),
    );
    // An alive group: spawn a detached sleeper and write a pidfile for it.
    const { spawn } = await import("node:child_process");
    const live = spawn("/bin/sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
    await new Promise((res) => setTimeout(res, 100));
    const liveFile = join(dir, "bg_live.json");
    writeFileSync(
      liveFile,
      JSON.stringify({ shellId: "bg_live", pgid: live.pid, command: "sleep 30", startedAt: 1, sessionId: "ghostS" }),
    );

    const fresh = new BackgroundShellManager();
    const orphans = fresh.reapOrphansFromPidfiles();

    expect(exists(deadFile)).toBe(false); // dead → deleted
    expect(orphans.some((o) => o.shellId === "bg_live")).toBe(true);
    expect(fresh.get("bg_live")?.status).toBe("orphaned");

    // Cleanup the live process.
    try { process.kill(-live.pid!, "SIGKILL"); } catch { /* ignore */ }
  });
});

describe("unknown shell errors", () => {
  test("readOutput / kill on unknown id report error", async () => {
    const read = mgr.readOutput("bg_nope", "all");
    expect(read.ok).toBe(false);
    const k = await mgr.kill("bg_nope");
    expect(k.ok).toBe(false);
  });
});

describe("spawnBackground sessionId safety", () => {
  test("refuses a path-traversal sessionId (no write outside bg-shells root)", () => {
    for (const sid of ["../escape", "a/b", "..", "", "x\\y"]) {
      const r = mgr.spawnBackground({ command: "echo hi", cwd: home, sessionId: sid });
      expect(r.ok, `sessionId ${JSON.stringify(sid)} must be refused`).toBe(false);
    }
  });

  test("accepts a normal nanoid-style sessionId", () => {
    const r = mgr.spawnBackground({ command: "true", cwd: home, sessionId: "s-mqe0ox7n-a8d11c26" });
    expect(r.ok).toBe(true);
  });
});
