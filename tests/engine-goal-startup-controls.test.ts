/** Real Engine startup controls: asynchronous hooks must not undo durable Goal CAS. */
import { afterAll, expect, test, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFixtureNetworkGuard } from "./helpers/network-fixture.js";

// Sandbox cannot run DiskManagement. Fixture only the external OS lookup;
// the real persistent identity reader still checks actual device/inode/birthtime.
const childProcess = await import("node:child_process");
const realExecFileSync = childProcess.execFileSync;
const diskInfo = spyOn(childProcess, "execFileSync").mockImplementation(((
  file: any,
  args: any,
  options: any,
) => {
  if (file === "/usr/sbin/diskutil")
    return `<plist><dict><key>VolumeUUID</key><string>11111111-2222-3333-4444-555555555555</string><key>DeviceNode</key><string>${args[2]}</string><key>MountPoint</key><string>/private/tmp</string></dict></plist>`;
  return realExecFileSync(file, args, options);
}) as any);
const network = installFixtureNetworkGuard(); // No origins allowed; installed before Engine import.
const { Engine } = await import("../packages/core/src/engine/engine.js");
const { PROVIDER_REGISTRY, registerProvider } =
  await import("../packages/core/src/llm/client-factory.js");
const { LLMClientBase } = await import("../packages/core/src/llm/client-base.js");
const { ChatSessionManager } =
  await import("../packages/core/src/protocol/chat-session-manager.js");
const { wakeSessionForBackgroundResults } =
  await import("../packages/core/src/protocol/background-result-wakeup.js");
const { backgroundShellManager } = await import("../packages/core/src/runtime/background-shell.js");
const { backgroundJobRegistry } =
  await import("../packages/core/src/tool-system/builtin/background-jobs.js");
const { notificationQueue } =
  await import("../packages/core/src/tool-system/builtin/agent-notifications.js");
const { ApprovalRouter } = await import("../packages/core/src/tool-system/permission.js");
afterAll(() => {
  network.restore();
  diskInfo.mockRestore();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const action of ["pause", "edit"] as const) {
  test(`waiting re-arm must preserve ${action} accepted during on_agent_start`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "engine-goal-startup-"));
    const startEntered = deferred();
    const startRelease = deferred();
    const modelEntered = deferred();
    const modelRelease = deferred();
    const saved = new Map(PROVIDER_REGISTRY);
    let calls = 0;
    class FakeProvider extends LLMClientBase {
      protected initClient() {}
      async createMessage() {
        calls++;
        modelEntered.resolve();
        await modelRelease.promise;
        return {
          text: "fixture answer",
          toolCalls: [],
          stopReason: "stop",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        } as any;
      }
    }
    PROVIDER_REGISTRY.clear();
    registerProvider("openai", FakeProvider);
    const engine = new Engine({
      cwd,
      sessionStorageDir: join(cwd, "sessions"),
      llm: {
        provider: "openai",
        providerKind: "openai",
        model: "fixture",
        apiKey: "fixture",
        enableStreaming: false,
      },
      enabledBuiltinTools: [],
      maxTurns: 1,
      headless: true,
      permissionMode: "bypassPermissions",
      hooks: [
        {
          event: "on_agent_start",
          async handler() {
            startEntered.resolve();
            await startRelease.promise;
            return {};
          },
        },
      ],
    });
    let running: Promise<unknown> | undefined;
    try {
      const manager = engine.getSessionManager();
      const { state } = manager.create(cwd, "fixture", "openai", "startup-race");
      const goal = {
        objective: "original objective",
        goalId: "startup-goal",
        revision: 7,
        tokenBudget: 10000,
      };
      expect(manager.saveActiveGoal(state, goal)).toBe(true);
      expect(manager.markGoalWaiting(state, goal, "background")).toBe(true);
      running = engine.run("continue from background", {
        sessionId: state.sessionId,
        injected: true,
      });
      await Promise.race([
        startEntered.promise,
        running.then(() => {
          throw new Error("run ended before startup hook");
        }),
      ]);
      expect(calls).toBe(0);
      const updated = engine.updateGoal(state.sessionId, {
        ...(action === "pause" ? { paused: true } : { objective: "edited objective" }),
        expectedGoalId: goal.goalId,
        expectedRevision: 7,
      });
      expect(updated?.revision).toBe(8);
      expect(manager.readActiveGoal(state.sessionId)).toEqual(updated);
      startRelease.resolve();
      const outcome = await Promise.race([
        modelEntered.promise.then(() => "provider"),
        running.then(() => "settled"),
      ]);
      expect(outcome).toBe("settled");
      expect(calls).toBe(0);
      expect(await running).toMatchObject({
        reason: "aborted_streaming",
        turnCount: 0,
        text: expect.stringContaining(
          action === "pause"
            ? "automatic continuation held"
            : "retry with the current Goal version",
        ),
      });
      const actual = manager.readActiveGoal(state.sessionId);
      expect(actual).toEqual(updated);
      const stopping = engine.dispose();
      modelRelease.resolve();
      await running;
      await stopping;
      expect(manager.readActiveGoal(state.sessionId)).toEqual(updated);
    } finally {
      startRelease.resolve();
      modelRelease.resolve();
      await running?.catch(() => {});
      await engine.dispose();
      PROVIDER_REGISTRY.clear();
      for (const [key, provider] of saved) PROVIDER_REGISTRY.set(key, provider);
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

test("saveActiveGoal with expected revision rejects a stale waiting snapshot", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "engine-goal-fence-"));
  const engine = new Engine({
    cwd,
    sessionStorageDir: join(cwd, "sessions"),
    llm: { provider: "openai", model: "fixture", apiKey: "fixture" },
    enabledBuiltinTools: [],
  });
  try {
    const manager = engine.getSessionManager();
    const { state } = manager.create(cwd, "fixture", "openai", "fenced");
    const goal = { objective: "original", goalId: "fenced-goal", revision: 7 };
    expect(manager.saveActiveGoal(state, goal)).toBe(true);
    expect(manager.markGoalWaiting(state, goal)).toBe(true);
    const updated = manager.updateActiveGoal(state.sessionId, {
      paused: true,
      expectedRevision: 7,
    });
    expect(
      manager.saveActiveGoal(state, goal, { expectedGoalId: goal.goalId, expectedRevision: 7 }),
    ).toBe(false);
    expect(manager.readActiveGoal(state.sessionId)).toEqual(updated?.goal);
  } finally {
    await engine.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("objective-only live edit must preserve previously extended token and time budgets", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "engine-goal-extend-edit-"));
  const entered = deferred();
  const release = deferred();
  const saved = new Map(PROVIDER_REGISTRY);
  class FakeProvider extends LLMClientBase {
    protected initClient() {}
    async createMessage() {
      entered.resolve();
      await release.promise;
      return {
        text: "fixture response",
        toolCalls: [],
        stopReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      } as any;
    }
  }
  PROVIDER_REGISTRY.clear();
  registerProvider("openai", FakeProvider);
  const engine = new Engine({
    cwd,
    sessionStorageDir: join(cwd, "sessions"),
    llm: {
      provider: "openai",
      providerKind: "openai",
      model: "fixture",
      apiKey: "fixture",
      enableStreaming: false,
    },
    enabledBuiltinTools: [],
    maxTurns: 1,
    headless: true,
    permissionMode: "bypassPermissions",
  });
  let running: Promise<unknown> | undefined;
  try {
    const sessionId = "extend-edit";
    engine.getSessionManager().create(cwd, "fixture", "openai", sessionId);
    running = engine.run("work on the goal", {
      sessionId,
      goal: { objective: "original objective", tokenBudget: 1000, timeBudgetMs: 600000 },
    });
    await Promise.race([
      entered.promise,
      running.then((result) => {
        throw new Error(`run ended before fake provider gate: ${JSON.stringify(result)}`);
      }),
    ]);
    const original = engine.getGoal(sessionId)!;
    expect(original).toBeDefined();
    const extended = engine.extendGoalRun({
      addTurns: 2,
      addTokenBudget: 5000,
      addTimeBudgetMs: 600000,
      addStopBlocks: 7,
    });
    expect(extended).toMatchObject({ tokenBudget: 6000, timeBudgetMs: 1200000 });
    // CONTROL: a repeated live query retains the extension before any edit.
    expect(engine.extendGoalRun({})).toEqual(extended);
    const edited = engine.updateGoal(sessionId, {
      objective: "edited objective only",
      expectedGoalId: original.goalId,
      expectedRevision: original.revision,
    });
    expect(edited?.objective).toBe("edited objective only");
    expect(edited?.revision).toBe((original.revision ?? 1) + 1);
    const actual = engine.extendGoalRun({});
    // CONTROL: all live extensions survive an objective edit; disk budgets remain original.
    expect(actual?.maxTurns).toBe(extended?.maxTurns);
    expect(actual?.maxStopBlocks).toBe(extended?.maxStopBlocks);
    expect(edited?.tokenBudget).toBe(1000); // Run-scoped extensions stay out of disk.
    expect(edited?.timeBudgetMs).toBe(600000);
    expect({ tokenBudget: actual?.tokenBudget, timeBudgetMs: actual?.timeBudgetMs }).toEqual({
      tokenBudget: extended?.tokenBudget,
      timeBudgetMs: extended?.timeBudgetMs,
    });
    const paused = engine.updateGoal(sessionId, { paused: true });
    expect(paused?.paused).toBe(true);
    engine.updateGoal(sessionId, { paused: false });
    expect(engine.extendGoalRun({})).toMatchObject({ tokenBudget: 1000, timeBudgetMs: 600000 });
  } finally {
    const disposed = engine.dispose();
    release.resolve();
    await running?.catch(() => {});
    await disposed;
    PROVIDER_REGISTRY.clear();
    for (const [key, provider] of saved) PROVIDER_REGISTRY.set(key, provider);
    rmSync(cwd, { recursive: true, force: true });
  }
});

async function until(condition: () => boolean, label: string) {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Fixture timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

for (const evict of [false, true]) {
  test(`Stop must suppress a real shell completion ${evict ? "after idle eviction and cold rehydrate" : "while the ChatSession remains resident"}`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "engine-stop-idle-shell-"));
    const previousHome = process.env.CODE_SHELL_HOME;
    process.env.CODE_SHELL_HOME = cwd;
    notificationQueue.reset();
    backgroundJobRegistry.reset();
    const saved = new Map(PROVIDER_REGISTRY);
    const modelEntered = deferred();
    const events: any[] = [];
    let providerCalls = 0;
    let engineCount = 0;
    class FakeProvider extends LLMClientBase {
      protected initClient() {}
      async createMessage(request: any) {
        providerCalls++;
        if (providerCalls === 1) {
          modelEntered.resolve();
          // A real active Engine run is stopped by the real ChatSession signal.
          await new Promise<void>((_resolve, reject) => {
            const abort = () =>
              reject(Object.assign(new Error("fixture request aborted"), { name: "AbortError" }));
            if (request.signal?.aborted) abort();
            else request.signal?.addEventListener("abort", abort, { once: true });
          });
        }
        const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
        this.recordUsage(usage, request);
        return {
          text: "fixture background result received",
          toolCalls: [],
          stopReason: "stop",
          usage,
        } as any;
      }
    }
    PROVIDER_REGISTRY.clear();
    registerProvider("openai", FakeProvider);
    const manager = new ChatSessionManager({
      runtime: {} as never,
      sessionStorageDir: join(cwd, "sessions"),
      idleTtlMs: 1,
      engineFactory: (slice) => {
        engineCount++;
        return new Engine({
          ...slice,
          cwd,
          sessionStorageDir: join(cwd, "sessions"),
          llm: {
            provider: "openai",
            providerKind: "openai",
            model: "fixture",
            apiKey: "fixture",
            enableStreaming: false,
          },
          enabledBuiltinTools: [],
          headless: false,
          maxTurns: 1,
          permissionMode: "bypassPermissions",
        });
      },
    });
    const sessionId = evict ? "stop-then-evict" : "stop-still-resident";
    const slice = { cwd, permissionMode: "bypassPermissions" as const };
    const session = await manager.getOrCreate(sessionId, slice);
    session.engine.getSessionManager().create(cwd, "fixture", "openai", sessionId);
    let running: Promise<unknown> | undefined;
    try {
      const shell = backgroundShellManager.spawnBackground({
        // The child remains alive across Stop/eviction; test releases it through
        // a local file instead of relying on wall-clock sleeps or a fake registry.
        command: "while [ ! -f release-shell ]; do sleep 0.05; done; printf 'fixture-complete\\n'",
        cwd,
        sessionId,
      });
      expect(shell.ok).toBe(true);
      if (!shell.ok) throw new Error(shell.error);
      expect(backgroundShellManager.get(shell.shellId)?.status).toBe("running");
      expect(backgroundJobRegistry.hasRunningForSession(sessionId)).toBe(false);

      running = session.enqueueTurn("Fixture foreground run to Stop", { cwd });
      await Promise.race([
        modelEntered.promise,
        running.then(() => {
          throw new Error("run ended before provider gate");
        }),
      ]);
      session.cancel();
      await running;
      await session.settled;
      expect(session.wasCancelledSinceLastTurn()).toBe(true);
      expect(session.isBusy()).toBe(false);
      const callsAtStop = providerCalls;
      expect(backgroundShellManager.get(shell.shellId)?.status).toBe("running");

      if (evict) {
        session.lastActivityAt = Date.now() - 60_000;
        manager.sweepIdle();
        await until(() => !manager.isClosing(sessionId), "idle disposal");
        expect(manager.get(sessionId)).toBeUndefined();
        expect(manager.isUnavailable(sessionId)).toBe(false);
        expect(backgroundShellManager.get(shell.shellId)?.status).toBe("running");
      }
      writeFileSync(join(cwd, "release-shell"), "finish");
      await until(
        () => notificationQueue.getSnapshot(sessionId).length > 0,
        "real shell completion notification",
      );
      expect(backgroundShellManager.get(shell.shellId)?.status).toBe("exited");
      expect(manager.sessionExistsOnDisk(sessionId, slice)).toBe(true);
      let coldStopFlag: boolean | undefined;
      const woke = await wakeSessionForBackgroundResults({
        sessionId,
        manager,
        notificationMailbox: notificationQueue,
        rehydrate: async (id) => {
          const cold = await manager.getOrCreate(id, slice, {
            allowReopen: false,
            restorePersistedModel: true,
          });
          coldStopFlag = cold.wasCancelledSinceLastTurn();
          return cold;
        },
        approvalRouter: new ApprovalRouter(),
        resolveWorkspace: async () => ({ cwd }),
        onStream: (event) => events.push(event),
      });
      const actual = {
        woke,
        providerCallsAfterStop: providerCalls - callsAtStop,
        pendingResults: notificationQueue.getSnapshot(sessionId).length,
        backgroundWakeStarted: events.some(
          (event) => event.type === "session_started" && event.trigger === "background_wake",
        ),
      };
      expect(engineCount).toBe(evict ? 2 : 1);
      if (evict) expect(coldStopFlag).toBe(true);
      expect(actual).toEqual({
        woke: false,
        providerCallsAfterStop: 0,
        pendingResults: 1,
        backgroundWakeStarted: false,
      });
      const current = manager.get(sessionId)!;
      await current.enqueueTurn("Read the queued shell result now", { cwd, trigger: "user" });
      expect(current.wasCancelledSinceLastTurn()).toBe(false);
      expect(providerCalls).toBeGreaterThan(callsAtStop);
    } finally {
      session.cancel();
      writeFileSync(join(cwd, "release-shell"), "finish");
      await running?.catch(() => {});
      await manager.closeAllAsync();
      backgroundShellManager._clear();
      notificationQueue.reset();
      backgroundJobRegistry.reset();
      PROVIDER_REGISTRY.clear();
      for (const [key, provider] of saved) PROVIDER_REGISTRY.set(key, provider);
      if (previousHome === undefined) delete process.env.CODE_SHELL_HOME;
      else process.env.CODE_SHELL_HOME = previousHome;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

for (const action of ["pause", "edit"] as const)
  test(`${action} during actual background wake preserves controls and executes only the latest Goal`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "goal-wake-hold-"));
    const saved = new Map(PROVIDER_REGISTRY);
    let calls = 0;
    let providerCalls = 0;
    let starts = 0;
    const entered = deferred();
    const release = deferred();
    const events: any[] = [];
    class NoProvider extends LLMClientBase {
      protected initClient() {}
      async createMessage(request: any): Promise<any> {
        providerCalls++;
        const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
        this.recordUsage(usage, request);
        if (request.usagePurpose === "goal_judge") {
          // Goal objectives are consumed by the judge, not repeated in the
          // primary prompt's capability-only Goal tool guidance.
          expect(JSON.stringify(request)).toContain("latest objective");
          expect(JSON.stringify(request)).not.toContain("OLD_GOAL_OBJECTIVE_SENTINEL");
          return {
            text: JSON.stringify({
              met: true,
              waiting: false,
              blockedOnUser: false,
              gaps: "",
            }),
            toolCalls: [],
            stopReason: "stop",
            usage,
          };
        }
        if (request.usagePurpose === "title")
          return { text: "fixture", toolCalls: [], stopReason: "stop", usage };
        calls++;
        expect(action).toBe("edit");
        expect(JSON.stringify(request)).not.toContain("OLD_GOAL_OBJECTIVE_SENTINEL");
        expect(engine.getGoal("wake-held")).toMatchObject({
          objective: "latest objective",
          revision: 8,
        });
        return {
          text: "done",
          toolCalls: [],
          stopReason: "stop",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      }
    }
    PROVIDER_REGISTRY.clear();
    registerProvider("openai", NoProvider);
    let engine: InstanceType<typeof Engine>;
    const manager = new ChatSessionManager({
      runtime: {} as never,
      sessionStorageDir: join(cwd, "sessions"),
      engineFactory: () =>
        (engine = new Engine({
          cwd,
          sessionStorageDir: join(cwd, "sessions"),
          enabledBuiltinTools: [],
          maxTurns: 3,
          llm: {
            provider: "openai",
            providerKind: "openai",
            model: "fixture",
            apiKey: "fixture",
            enableStreaming: false,
          },
          hooks: [
            {
              event: "on_agent_start",
              async handler() {
                if (starts++ > 0) return {};
                entered.resolve();
                await release.promise;
                return {};
              },
            },
          ],
        })),
    });
    try {
      const session = await manager.getOrCreate("wake-held", { cwd });
      const state = session.engine
        .getSessionManager()
        .create(cwd, "fixture", "openai", session.id).state;
      const goal = { objective: "OLD_GOAL_OBJECTIVE_SENTINEL", goalId: "wake", revision: 7 };
      session.engine.getSessionManager().saveActiveGoal(state, goal);
      session.engine.getSessionManager().markGoalWaiting(state, goal, "background");
      const original = notificationQueue.enqueue(
        {
          agentId: "job",
          description: "result",
          finalText: "done",
          status: "completed",
          enqueuedAt: 1,
        },
        session.id,
      );
      const waking = wakeSessionForBackgroundResults({
        sessionId: session.id,
        manager,
        rehydrate: async () => session,
        approvalRouter: new ApprovalRouter(),
        resolveWorkspace: async () => ({ cwd }),
        onStream: (event) => events.push(event),
      });
      await Promise.race([
        entered.promise,
        waking.then(() => {
          throw new Error("wake ended before startup gate");
        }),
      ]);
      expect(providerCalls).toBe(0);
      expect(
        engine!.updateGoal("wake-held", {
          ...(action === "pause" ? { paused: true } : { objective: "latest objective" }),
          expectedGoalId: "wake",
          expectedRevision: 7,
        })?.revision,
      ).toBe(8);
      release.resolve();
      const woke = await waking;
      expect(events.filter((event) => event.type === "error")).toEqual([]);
      expect({ woke, starts, calls }).toEqual({
        woke: action === "edit",
        starts: action === "edit" ? 2 : 1,
        calls: action === "edit" ? 1 : 0,
      });
      expect(calls).toBe(action === "edit" ? 1 : 0);
      if (action === "pause") expect(providerCalls).toBe(0);
      else expect(providerCalls).toBeGreaterThan(0);
      expect(starts).toBe(action === "edit" ? 2 : 1);
      expect(events.some((event) => event.type === "error")).toBe(false);
      expect(notificationQueue.getSnapshot(session.id)).toEqual(
        action === "pause" ? [original] : [],
      );
      if (action === "pause")
        expect(session.engine.getGoal(session.id)).toMatchObject({
          goalId: "wake",
          revision: 8,
          paused: true,
        });
      else
        expect(
          session.engine.getSessionManager().readSessionState(session.id)?.goalLifecycle,
        ).toMatchObject({
          goalId: "wake",
          revision: 8,
          phase: "terminal",
          config: { objective: "latest objective" },
        });
      // Known boundary: startup hold already has a durable input/run identity.
      // A retry preserves that history and creates a second injected input; fixing
      // projections/receipts together is tracked in TODO.md, not hidden by rollback.
      const persisted = session.engine.getSessionManager().resume(session.id);
      // Engine context (ledger snapshot, hook reminders) is history but not input.
      const injected = persisted.transcript
        .toConversationMessages()
        .filter((m) => m.role === "user");
      expect(injected).toHaveLength(action === "edit" ? 2 : 1);
      if (action === "edit") expect(injected[0].content).toEqual(injected[1].content);
      const { readOutputJournal } = await import("../packages/core/src/session/output-journal.js");
      const journal = readOutputJournal(join(cwd, "sessions"), session.id);
      expect(journal.status).toBe("ok");
      const inputs = journal.frames.filter((f) => f.event.type === "session_user_message");
      expect(inputs).toHaveLength(action === "edit" ? 2 : 1);
      expect(new Set(inputs.map((f) => f.event.runId)).size).toBe(inputs.length);
    } finally {
      release.resolve();
      await manager.closeAllAsync();
      notificationQueue.reset();
      PROVIDER_REGISTRY.clear();
      for (const [name, provider] of saved) PROVIDER_REGISTRY.set(name, provider);
      rmSync(cwd, { recursive: true, force: true });
    }
  });
