/**
 * Lifecycle: closeAll() (server/app shutdown) must reap background shells
 * (design §6 "app/worker 正常退出 → killAll()"). Idle-sweep close() must NOT
 * — a dev server survives the user switching away (§6 "关闭单个聊天 tab 不杀").
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatSessionManager } from "./chat-session-manager.js";
import { backgroundShellManager } from "../runtime/background-shell.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "csm-killshell-"));
  process.env.CODE_SHELL_HOME = home;
});
afterEach(async () => {
  await backgroundShellManager.killAll();
  backgroundShellManager._clear();
  rmSync(home, { recursive: true, force: true });
  delete process.env.CODE_SHELL_HOME;
});

async function until(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("until() timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("closeAll reaps the singleton's background shells", () => {
  test("a running shell is killed after closeAll", async () => {
    const mgr = new ChatSessionManager({ runtime: {} as never, engineFactory: () => ({}) as never });
    const r = backgroundShellManager.spawnBackground({
      command: "sleep 100",
      cwd: home,
      sessionId: "sX",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(backgroundShellManager.get(r.shellId)?.status).toBe("running");

    mgr.closeAll();

    await until(() => backgroundShellManager.get(r.shellId)?.status === "killed");
    expect(backgroundShellManager.get(r.shellId)?.status).toBe("killed");
  });
});
