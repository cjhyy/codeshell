import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundShellManager } from "../../runtime/background-shell.js";
import { bashOutputTool, killShellTool, listShellsTool } from "./background-shell-tools.js";
import { bashTool } from "./bash.js";

function text(out: string | { result?: string; error?: string }): string {
  return typeof out === "string" ? out : (out.result ?? out.error ?? "");
}
import type { ToolContext, ToolRunYieldReason } from "../context.js";
import { notificationQueue } from "./agent-notifications.js";

let home: string;
let mgr: BackgroundShellManager;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bgtools-"));
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

async function until(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("until() timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function ctx(sessionId = "sessA"): ToolContext {
  return {
    cwd: home,
    sessionId,
    backgroundShells: mgr,
  } as unknown as ToolContext;
}

function yieldingContext() {
  const context = ctx();
  const pending = new Set<ToolRunYieldReason>();
  context.runYield = {
    request: (reason) => {
      pending.add(reason);
    },
    peek: (reason) => pending.has(reason),
    consume: (reason) => pending.delete(reason),
  };
  return { context, pending };
}

describe("Bash run_in_background", () => {
  test("an omitted behavior keeps the exit-wait boundary for existing callers", async () => {
    const { context, pending } = yieldingContext();
    const out = await bashTool({ command: "sleep 100", run_in_background: true }, context);
    expect(text(out)).toBeTypeOf("string");
    expect(text(out)).toContain("shell_id:");
    expect(text(out)).toMatch(/bg_/);
    expect(mgr.listForSession("sessA")).toHaveLength(1);
    expect(pending.has("background_notification")).toBe(true);
  });

  test("continue keeps a background service running without yielding the turn", async () => {
    const { context, pending } = yieldingContext();
    const out = await bashTool(
      { command: "sleep 100", run_in_background: true, background_behavior: "continue" },
      context,
    );
    expect(text(out)).toContain("shell_id:");
    expect(text(out)).toContain("background_behavior: continue");
    expect(mgr.listForSession("sessA")).toHaveLength(1);
    expect(mgr.listForSession("sessA")[0]!.status).toBe("running");
    expect(pending.size).toBe(0);
  });

  test("wait_for_exit explicitly requests the completion boundary", async () => {
    const { context, pending } = yieldingContext();
    const out = await bashTool(
      { command: "sleep 100", run_in_background: true, background_behavior: "wait_for_exit" },
      context,
    );
    expect(text(out)).toContain("shell_id:");
    expect(pending.has("background_notification")).toBe(true);
  });

  test.each(["wait", null, true])(
    "rejects invalid behavior %p before spawning",
    async (behavior) => {
      const { context, pending } = yieldingContext();
      const spawn = spyOn(mgr, "spawnBackground");
      try {
        const out = await bashTool(
          { command: "sleep 100", run_in_background: true, background_behavior: behavior },
          context,
        );
        expect(out).toMatchObject({
          ok: false,
          error: expect.stringContaining("background_behavior"),
        });
        expect(spawn).not.toHaveBeenCalled();
        expect(pending.size).toBe(0);
      } finally {
        spawn.mockRestore();
      }
    },
  );

  test.each(["continue", "wait_for_exit"])(
    "failed spawn does not yield in %s mode",
    async (behavior) => {
      const { context, pending } = yieldingContext();
      const spawn = spyOn(mgr, "spawnBackground").mockReturnValue({
        ok: false,
        error: "fixture spawn failure",
      });
      try {
        const out = await bashTool(
          { command: "fixture command", run_in_background: true, background_behavior: behavior },
          context,
        );
        expect(out).toMatchObject({
          ok: false,
          error: expect.stringContaining("fixture spawn failure"),
        });
        expect(pending.size).toBe(0);
      } finally {
        spawn.mockRestore();
      }
    },
  );

  test("automation context rejects run_in_background", async () => {
    const c = { ...ctx(), allowBackgroundShells: false } as unknown as ToolContext;
    const out = await bashTool({ command: "sleep 100", run_in_background: true }, c);
    expect(text(out)).toMatch(/not available|disabled|automation/i);
    expect(mgr.listForSession("sessA")).toHaveLength(0);
  });

  test("normal foreground bash still works (no run_in_background)", async () => {
    const out = await bashTool({ command: "echo hello" }, ctx());
    expect(text(out)).toContain("hello");
  });
});

describe("BashOutput tool", () => {
  test("reads output of a background shell", async () => {
    const r = mgr.spawnBackground({ command: "echo hi; sleep 0.2", cwd: home, sessionId: "sessA" });
    if (!r.ok) throw new Error("spawn");
    await until(() => (mgr.readOutputRaw(r.shellId) ?? "").includes("hi"));
    const out = await bashOutputTool({ shell_id: r.shellId }, ctx());
    expect(text(out)).toContain("hi");
    expect(text(out)).toContain(r.shellId);
  });

  test("unknown shell_id → error string", async () => {
    const out = await bashOutputTool({ shell_id: "bg_none" }, ctx());
    expect(text(out)).toMatch(/Unknown shell_id/);
  });

  test("cross-session shell_id is not readable", async () => {
    const r = mgr.spawnBackground({ command: "sleep 1", cwd: home, sessionId: "other" });
    if (!r.ok) throw new Error("spawn");
    const out = await bashOutputTool({ shell_id: r.shellId }, ctx("sessA"));
    expect(text(out)).toMatch(/Unknown shell_id/);
  });
});

describe("KillShell tool", () => {
  test("kills a running background shell", async () => {
    const r = mgr.spawnBackground({ command: "sleep 100", cwd: home, sessionId: "sessA" });
    if (!r.ok) throw new Error("spawn");
    const out = await killShellTool({ shell_id: r.shellId }, ctx());
    expect(text(out)).toMatch(/killed|terminated|already/i);
    await until(() => mgr.get(r.shellId)?.status === "killed");
  });
});

describe("ListShells tool", () => {
  test("lists background shells for the session with status/port", async () => {
    const r = mgr.spawnBackground({
      command: "echo 'http://localhost:3000'; sleep 100",
      cwd: home,
      sessionId: "sessA",
    });
    if (!r.ok) throw new Error("spawn");
    await until(() => mgr.get(r.shellId)?.detectedPort === 3000);
    const out = await listShellsTool({}, ctx());
    expect(text(out)).toContain(r.shellId);
    expect(text(out)).toContain("3000");
  });

  test("empty when no shells", async () => {
    const out = await listShellsTool({}, ctx());
    expect(text(out)).toMatch(/no background shells|none/i);
  });
});
