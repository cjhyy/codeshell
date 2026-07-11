import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentServer } from "./server.js";
import { ChatSessionManager, type EngineConfigSlice } from "./chat-session-manager.js";
import { SessionManager } from "../session/session-manager.js";
import { notificationQueue } from "../tool-system/builtin/agent-notifications.js";
import type { Engine, EngineResult } from "../engine/engine.js";

/**
 * Bug: a background shell (run_in_background Bash, e.g. a yt-dlp download) that
 * finishes while the agent is idle enqueues a completion notification but
 * NOTHING starts a new turn — the engine already resolved `engine.done`, so the
 * notification just sits in the queue until the user manually sends. The result
 * is "download finished but the agent never picked it up" (session
 * s-mqgienyz-6c760b76).
 *
 * Fix: the server subscribes to the notification bus and, when a completion
 * lands for an IDLE session it owns, wakes that session with one run whose task
 * is the drained notification(s) — so the model reads "download complete" and
 * continues on its own (the goal, persisted across turns, is judged that turn).
 *
 * Constraint preserved: a never-exiting dev server never emits a completion
 * notification, so it never triggers a wakeup. No task/service classification.
 */

function makeTransport() {
  const sent: any[] = [];
  let onMsg: (msg: unknown) => void = () => {};
  return {
    sent,
    deliver: (msg: unknown) => onMsg(msg),
    transport: {
      send: (m: unknown) => sent.push(m),
      onMessage: (cb: (msg: unknown) => void) => {
        onMsg = cb;
      },
      close: () => {},
    } as any,
  };
}

/** Fake engine recording every run task; resolves trivially. */
function makeFakeEngine() {
  const runs: string[] = [];
  const engine = {
    setAskUser() {},
    setPlanMode() {},
    isHeadless: () => false,
    async run(task: string): Promise<EngineResult> {
      runs.push(task);
      return {
        text: "ok",
        reason: "completed",
        sessionId: "sess-1",
        turnCount: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    },
  } as unknown as Engine;
  return { engine, runs };
}

function makeRehydratableEngineFactory(
  existsOnDisk: boolean | ((sessionId: string) => boolean),
  resultSessionId = "sess-1",
) {
  const runs: Array<{ engineId: number; task: string; cwd?: string; injected?: boolean }> = [];
  const slices: EngineConfigSlice[] = [];
  let nextEngineId = 0;
  const engineFactory = (slice: EngineConfigSlice) => {
    const engineId = ++nextEngineId;
    slices.push(slice);
    return {
      setAskUser() {},
      setBrowserBridge() {},
      setInjectCredential() {},
      setPlanMode() {},
      isHeadless: () => false,
      sessionExistsOnDisk: (sessionId: string) =>
        typeof existsOnDisk === "function" ? existsOnDisk(sessionId) : existsOnDisk,
      async run(task: string, opts?: { cwd?: string; injected?: boolean }): Promise<EngineResult> {
        runs.push({ engineId, task, cwd: opts?.cwd, injected: opts?.injected });
        return {
          text: "ok",
          reason: "completed",
          sessionId: resultSessionId,
          turnCount: 1,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
      },
    } as unknown as Engine;
  };
  return { engineFactory, runs, slices };
}

function enqueueShellExit(sid: string, agentId = "bg_abc123") {
  notificationQueue.enqueue(
    {
      agentId,
      name: "background shell",
      description: `Background shell exited (exit 0): yt-dlp ...`,
      status: "completed",
      enqueuedAt: 1,
    },
    sid,
  );
}

describe("AgentServer — background shell completion wakes an idle session", () => {
  // Each AgentServer subscribes to the process-singleton notification bus in
  // its constructor; close() unsubscribes. Track + close per test so a prior
  // test's server doesn't keep handling completions for the next test's
  // sessions (the bus is shared across the whole process).
  const servers: AgentServer[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
    notificationQueue.reset();
  });

  it("starts a run carrying the notification when the session is idle", async () => {
    const { engine, runs } = makeFakeEngine();
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => engine,
    });
    // Materialize the session so chatManager.get(sid) finds it.
    chatManager.getOrCreate("sess-1", {} as never);
    const t = makeTransport();
    servers.push(new AgentServer({ transport: t.transport, chatManager }));

    expect(runs.length).toBe(0);

    enqueueShellExit("sess-1");
    await new Promise((r) => setTimeout(r, 20));

    // Exactly one wakeup run, and its task surfaces the completion.
    expect(runs.length).toBe(1);
    expect(runs[0]).toContain("Background shell exited");
    // Drained: the queue is empty so it isn't re-delivered.
    expect(notificationQueue.getSnapshot("sess-1").length).toBe(0);
  });

  it("does NOT wake a busy session (the in-flight run drains it at end)", async () => {
    // Engine whose run blocks until released, so the session stays busy.
    const runs: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const engine = {
      setAskUser() {},
      setPlanMode() {},
      isHeadless: () => false,
      async run(task: string): Promise<EngineResult> {
        runs.push(task);
        await gate;
        return {
          text: "ok",
          reason: "completed",
          sessionId: "sess-1",
          turnCount: 1,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
      },
    } as unknown as Engine;
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => engine,
    });
    const session = chatManager.getOrCreate("sess-1", {} as never);
    const t = makeTransport();
    servers.push(new AgentServer({ transport: t.transport, chatManager }));

    // Make the session busy.
    void session.enqueueTurn("user task", {});
    await new Promise((r) => setTimeout(r, 5));
    expect(runs.length).toBe(1);

    // Completion arrives while busy → must NOT start a second run; the
    // notification stays queued for the in-flight run's end-of-turn drain.
    enqueueShellExit("sess-1");
    await new Promise((r) => setTimeout(r, 20));
    expect(runs.length).toBe(1);
    expect(notificationQueue.getSnapshot("sess-1").length).toBe(1);

    release();
  });

  it("emits a terminal error when the woken run fails (clears UI busy, no false 'completed')", async () => {
    // Engine whose run rejects synchronously (e.g. a setup error before the
    // turn-loop emits its own error event). The renderer set the composer busy
    // on session_started; without a terminal event it would stick. The terminal
    // must be `error` (not turn_complete) so a woken automation session's
    // runStatus isn't mislabeled "completed".
    const engine = {
      setAskUser() {},
      setPlanMode() {},
      isHeadless: () => false,
      async run(): Promise<EngineResult> {
        throw new Error("boom: setup failed");
      },
    } as unknown as Engine;
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => engine,
    });
    chatManager.getOrCreate("sess-1", {} as never);
    const t = makeTransport();
    servers.push(new AgentServer({ transport: t.transport, chatManager }));

    enqueueShellExit("sess-1");
    await new Promise((r) => setTimeout(r, 20));

    // An `error` StreamEvent for this session must have been sent so the
    // renderer's busy-clear fires and runStatus flips to "failed".
    const terminal = t.sent.find(
      (m: any) =>
        m?.method === "agent/streamEvent" &&
        m?.params?.sessionId === "sess-1" &&
        m?.params?.event?.type === "error",
    );
    expect(terminal).toBeDefined();
    // It must NOT mislabel as a completed turn.
    const falseComplete = t.sent.find(
      (m: any) =>
        m?.method === "agent/streamEvent" &&
        m?.params?.sessionId === "sess-1" &&
        m?.params?.event?.type === "turn_complete",
    );
    expect(falseComplete).toBeUndefined();
  });

  it("does NOT wake a session the user just Stopped (cancel suppresses wakeup)", async () => {
    const { engine, runs } = makeFakeEngine();
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => engine,
    });
    const session = chatManager.getOrCreate("sess-1", {} as never);
    const t = makeTransport();
    servers.push(new AgentServer({ transport: t.transport, chatManager }));

    // User hit Stop: cancel() leaves the session idle but suppresses wakeup.
    session.cancel();
    expect(session.isBusy()).toBe(false);

    // A background shell finishing right after Stop must NOT restart the agent.
    enqueueShellExit("sess-1");
    await new Promise((r) => setTimeout(r, 20));
    expect(runs.length).toBe(0);
    // The notification is left queued (a later user send will drain it).
    expect(notificationQueue.getSnapshot("sess-1").length).toBe(1);

    // After the user engages again, wakeups resume.
    await session.enqueueTurn("user is back", {});
    expect(runs.length).toBe(1);
    enqueueShellExit("sess-1", "bg_second");
    await new Promise((r) => setTimeout(r, 20));
    expect(runs.length).toBe(2);
  });

  it("does nothing for a session this server does not own", async () => {
    const { engine, runs } = makeFakeEngine();
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => engine,
    });
    const t = makeTransport();
    servers.push(new AgentServer({ transport: t.transport, chatManager }));

    enqueueShellExit("unknown-session");
    await new Promise((r) => setTimeout(r, 20));
    expect(runs.length).toBe(0);
  });

  it("does not rehydrate a closed session when background work finishes afterward", async () => {
    const sid = "bg-wake-closed-s1";
    const { engineFactory, runs } = makeRehydratableEngineFactory(true, sid);
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory,
    });
    const t = makeTransport();
    servers.push(new AgentServer({ transport: t.transport, chatManager }));

    const session = chatManager.getOrCreate(sid, { cwd: "/tmp/project-closed" } as never);
    await session.enqueueTurn("initial user turn", {});
    await chatManager.close(sid);
    expect(chatManager.get(sid)).toBeUndefined();

    enqueueShellExit(sid);
    await new Promise((r) => setTimeout(r, 20));

    expect(runs.map((r) => r.task)).toEqual(["initial user turn"]);
    expect(chatManager.get(sid)).toBeUndefined();
    expect(notificationQueue.getSnapshot(sid)).toHaveLength(1);
  });

  it("rehydrates an idle-evicted disk-backed session and wakes it with the pending notification", async () => {
    const sid = "bg-wake-rehydrate-s1";
    const { engineFactory, runs, slices } = makeRehydratableEngineFactory(
      (sessionId) => sessionId === sid,
      sid,
    );
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory,
      idleTtlMs: 0,
    });
    const t = makeTransport();
    servers.push(new AgentServer({ transport: t.transport, chatManager }));

    t.deliver({
      jsonrpc: "2.0",
      id: 1,
      method: "agent/run",
      params: {
        sessionId: sid,
        task: "initial user turn",
        cwd: "/tmp/project-a",
        permissionMode: "bypassPermissions",
        projectTrusted: false,
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(runs.map((r) => r.task)).toEqual(["initial user turn"]);
    expect(chatManager.get(sid)).toBeDefined();

    chatManager.get(sid)!.lastActivityAt = Date.now() - 1;
    chatManager.sweepIdle();
    await new Promise((r) => setTimeout(r, 0));
    expect(chatManager.get(sid)).toBeUndefined();

    enqueueShellExit(sid);
    await new Promise((r) => setTimeout(r, 20));

    expect(runs).toHaveLength(2);
    expect(runs[1].task).toContain("Background shell exited");
    expect(runs[1].injected).toBe(true);
    expect(chatManager.get(sid)).toBeDefined();
    expect(notificationQueue.getSnapshot(sid)).toHaveLength(0);
    expect(slices[slices.length - 1]).toMatchObject({
      cwd: "/tmp/project-a",
      projectTrusted: false,
    });
    // permissionMode was a one-turn override; the synthetic wakeup must fall
    // back to the engine factory's global default instead of inheriting it.
    expect(slices[slices.length - 1]!.permissionMode).toBeUndefined();
  });

  it("does not rehydrate or drain when an evicted session is absent from disk", async () => {
    const { engineFactory, runs } = makeRehydratableEngineFactory(false);
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory,
    });
    const t = makeTransport();
    servers.push(new AgentServer({ transport: t.transport, chatManager }));

    enqueueShellExit("missing-session");
    await new Promise((r) => setTimeout(r, 20));

    expect(runs).toHaveLength(0);
    expect(chatManager.get("missing-session")).toBeUndefined();
    expect(notificationQueue.getSnapshot("missing-session")).toHaveLength(1);
  });

  it("can rehydrate from persisted state.json cwd when the run-slice cache is cold", async () => {
    const sid = "bg-wake-state-s1";
    const home = mkdtempSync(join(tmpdir(), "cs-bg-wake-home-"));
    const previousHome = process.env.CODE_SHELL_HOME;
    process.env.CODE_SHELL_HOME = home;
    try {
      new SessionManager().create("/tmp/project-from-state", "model-a", "provider-a", sid);
      const { engineFactory, runs, slices } = makeRehydratableEngineFactory(
        (sessionId) => sessionId === sid,
        sid,
      );
      const chatManager = new ChatSessionManager({
        runtime: {} as never,
        engineFactory,
      });
      const t = makeTransport();
      servers.push(new AgentServer({ transport: t.transport, chatManager }));

      enqueueShellExit(sid);
      await new Promise((r) => setTimeout(r, 20));

      expect(runs).toHaveLength(1);
      expect(runs[0].task).toContain("Background shell exited");
      expect(slices[slices.length - 1]).toMatchObject({ cwd: "/tmp/project-from-state" });
      expect(notificationQueue.getSnapshot(sid)).toHaveLength(0);
    } finally {
      if (previousHome === undefined) delete process.env.CODE_SHELL_HOME;
      else process.env.CODE_SHELL_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
