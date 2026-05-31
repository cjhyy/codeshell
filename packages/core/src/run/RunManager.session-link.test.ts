import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunManager } from "./RunManager.js";
import { FileRunStore } from "./FileRunStore.js";
import type { RunExecutor } from "./EngineRunner.js";
import type { StreamEvent } from "../types.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "rm-link-"));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const noopHandle = {
  resolveApproval: () => false,
  resolveInput: () => false,
  hasPendingApproval: () => false,
  hasPendingInput: () => false,
};

async function waitForTerminal(mgr: RunManager, runId: string): Promise<void> {
  const terminal = new Set(["completed", "failed", "cancelled"]);
  for (let i = 0; i < 200; i++) {
    const s = await mgr.get(runId);
    if (s && terminal.has(s.status)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("run did not reach terminal state in time");
}

describe("RunManager links sessionId on session_started", () => {
  test("links sessionId mid-run, not only at completion; exactly one session_linked", async () => {
    const dir = tmp();
    const store = new FileRunStore(dir);
    let midRunSessionId: string | null | undefined = "UNSET";
    const executor: RunExecutor = {
      async execute(run, context) {
        await context.onStream?.({ type: "session_started", sessionId: "sess-early", promptTokens: 0 } as StreamEvent);
        // Snapshot must already carry the sessionId now (mid-run).
        midRunSessionId = (await store.get(run.runId))?.sessionId;
        return {
          result: { text: "ok", reason: "completed", sessionId: "sess-early", turnCount: 1 },
          handle: noopHandle,
        };
      },
    };
    const mgr = new RunManager({ store, executor, runsDir: dir });
    const { runId } = await mgr.submit({ objective: "x", cwd: "/tmp/proj" });
    await waitForTerminal(mgr, runId);

    expect(midRunSessionId).toBe("sess-early");
    const snap = await mgr.get(runId);
    expect(snap?.sessionId).toBe("sess-early");
    const linked = (await mgr.getEvents(runId)).filter((e) => e.type === "session_linked");
    expect(linked).toHaveLength(1);
    expect(linked[0].data.sessionId).toBe("sess-early");
  });

  test("does not link a sub-agent session_started (event carries agentId)", async () => {
    const dir = tmp();
    const store = new FileRunStore(dir);
    const executor: RunExecutor = {
      async execute(run, context) {
        await context.onStream?.({ type: "session_started", sessionId: "sub-sess", promptTokens: 0, agentId: "sub-1" } as unknown as StreamEvent);
        return {
          result: { text: "ok", reason: "completed", sessionId: "main-sess", turnCount: 1 },
          handle: noopHandle,
        };
      },
    };
    const mgr = new RunManager({ store, executor, runsDir: dir });
    const { runId } = await mgr.submit({ objective: "x", cwd: "/tmp/proj" });
    await waitForTerminal(mgr, runId);
    const snap = await mgr.get(runId);
    expect(snap?.sessionId).toBe("main-sess"); // linked at completion to main, NOT to the sub-agent's sub-sess
  });
});
