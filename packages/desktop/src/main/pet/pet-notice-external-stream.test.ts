/**
 * Mimi notices for desktop external runtimes (Codex / Claude Code run in Main):
 * the real ExternalRuntimeService, with a fake provider, publishes into the
 * real outcome tap, notice wiring and long-task coordinator.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionManager,
  sessionsRoot,
  type StreamEvent,
  type ToolRegistry,
} from "@cjhyy/code-shell-core";
import {
  createSessionToolHost,
  deriveExternalToolExposure,
  intersectExternalToolExposure,
} from "@cjhyy/code-shell-core/extension";
import { readOutputJournal } from "@cjhyy/code-shell-core/internal";
import type { PetLongTask, PetReportToMimiEvent } from "@cjhyy/code-shell-pet";
import { INITIAL_STATE, applyStreamEvent } from "../../renderer/types.js";
import { ExternalRunEnvelope, externalRunTrigger } from "../external-runtime-run-envelope.js";
import {
  ExternalRuntimeService,
  type ExternalRuntimeServiceDeps,
} from "../external-runtime-service.js";
import { createExternalSessionCatalog } from "./pet-notice-external-sessions.js";
import { PetLongTaskCoordinator } from "./pet-long-task-coordinator.js";
import { PetLongTaskStore } from "./pet-long-task-store.js";
import type { DesktopPetProjectionSnapshot } from "./pet-state-aggregator.js";
import { petDelegationClientMessageId } from "./pet-work-delegation-host.js";
import {
  feedSessionOutcomeTap,
  SessionOutcomeDeriver,
  type SessionOutcome,
  type SessionOutcomeSources,
} from "./session-outcome.js";
import {
  boundRoute,
  cleanupNoticeEnv,
  env,
  harness,
  NOW,
  resetNoticeEnv,
  settle,
  upsertArgs,
  type Harness,
} from "./test-utils/notice-wiring-harness.js";

type StartArgs = Parameters<NonNullable<ExternalRuntimeServiceDeps["startSession"]>>[0];
type ProviderTurn = (args: StartArgs, emit: (event: StreamEvent) => void) => Promise<void>;
/** What the fake provider does in each provider turn (one per Goal round). */
let providerTurn: ProviderTurn | undefined;
let lastStart: StartArgs | undefined;
/** The provider's interrupt (a limit pause or a Stop) ends its held turn. */
let onInterrupt: (() => void) | undefined;
let interrupted = false;
/** Background work of the Session (DriveAgent jobs), for the run's park. */
let backgroundRunning = false;
/** The provider runtime, injected: no CLI process, no network. */
const startSession = (async (args: StartArgs) => {
  lastStart = args;
  return {
    kind: args.kind,
    businessSessionId: args.businessSessionId,
    runtimeSessionId: "fixture-provider-session",
    listTools: () => [],
    close: async () => {},
    interrupt: async () => {
      interrupted = true;
      onInterrupt?.();
    },
    send: async (_input: unknown, onEvent: (event: StreamEvent) => void) => {
      await providerTurn?.(args, onEvent);
      return { done: Promise.resolve(), accepted: true as const };
    },
  };
}) as unknown as NonNullable<ExternalRuntimeServiceDeps["startSession"]>;

const CODEX = "s-codex-notice";
let home: string;
let previousHome: string | undefined;
let cwd: string;
let svc: ExternalRuntimeService;
let current: Harness | undefined;
/** Every event the service published, as the bridge would hand it on. */
const published: StreamEvent[] = [];
/** ReportToMimi events handed to Main's report observer. */
const reports: PetReportToMimiEvent[] = [];
/** Where published events go (the notice harness's tap by default). */
let sink: (sessionId: string, event: StreamEvent) => void = () => undefined;

beforeEach(async () => {
  await resetNoticeEnv();
  home = mkdtempSync(join(tmpdir(), "codeshell-external-notices-"));
  previousHome = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = join(home, "home");
  cwd = join(home, "workspace");
  mkdirSync(cwd);
  published.length = 0;
  reports.length = 0;
  providerTurn = undefined;
  onInterrupt = undefined;
  interrupted = false;
  backgroundRunning = false;
  svc = new ExternalRuntimeService({
    featureFlags: () => ({ external_agent_runtime: true, external_host_tools: true }),
    registerSession: () => {},
    releaseSession: () => {},
    resolveProjectBinding: () => undefined,
    emit: (sessionId, event) => {
      published.push(event);
      sink(sessionId, event);
    },
    projectTrust: () => "untrusted",
    prepareCodexLaunch: async () => ({ command: "/fixture/codex", env: { PATH: "/fixture" } }),
    startSession,
    backgroundWork: {
      subscribe: () => () => undefined,
      claimResults: () => undefined,
      hasPending: () => false,
      hasRunning: () => backgroundRunning,
      dropSession: () => undefined,
    },
    // Main's handlers, in-process: the notice wiring a test builds, and Mimi's report observer.
    mimiTools: () => ({
      upsertRule: (sessionId, args) => {
        if (!current) throw new Error("no notice wiring");
        return current.wiring.upsertRule(sessionId, args);
      },
      report: (event) => reports.push(event),
    }),
  });
  await svc.start({ kind: "codex", sessionId: CODEX, cwd });
});

afterEach(async () => {
  await cleanupNoticeEnv(current);
  current = undefined;
  sink = () => undefined;
  await svc.stopAll();
  if (previousHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

/** The real notice wiring, knowing the Codex Session through the real catalog. */
function noticeHarness(): Harness {
  const target = harness({
    externalSessions: createExternalSessionCatalog({
      runtime: () => svc,
      readState: (id) => new SessionManager().readSessionState(id),
    }),
  });
  sink = (sessionId, event) => target.observeSessionEvent(sessionId, event);
  return target;
}

/** Collect what the deriver makes of every published event. */
function deriveAll(): SessionOutcome[] {
  const deriver = new SessionOutcomeDeriver();
  const outcomes: SessionOutcome[] = [];
  sink = (sessionId, event) => outcomes.push(...deriver.derive(sessionId, event));
  return outcomes;
}

const tool = (toolName: string, id = `call-${toolName}`): StreamEvent[] => [
  { type: "tool_use_start", toolCall: { id, toolName, args: {} } },
  { type: "tool_result", result: { id, toolName, result: "ok" } },
];
const reply = (text: string): StreamEvent => ({ type: "text_delta", text });
const ofType = <T extends StreamEvent["type"]>(type: T) =>
  published.filter((event) => event.type === type) as Extract<StreamEvent, { type: T }>[];
/** The provider holds its turn until the host interrupts it, then ends it aborted. */
const untilInterrupted = (emit: (event: StreamEvent) => void) =>
  new Promise<void>((resolve) => {
    onInterrupt = () => {
      emit({ type: "turn_complete", reason: "aborted_streaming" });
      resolve();
    };
    // A token budget interrupts synchronously, while the usage is reported.
    if (interrupted) onInterrupt();
  });
/** The renderer's messages after folding these events, as on a journal replay. */
const rendered = (events: readonly StreamEvent[]) =>
  events.reduce((state, event) => applyStreamEvent(state, event, () => 1), INITIAL_STATE).messages;
const goalIdentity = () => {
  const goal = svc.getGoal(CODEX);
  return { goalId: goal.goalId, revision: goal.revision };
};

describe("the external run envelope", () => {
  test("a user turn says why it started and what it did, with the run's identity", async () => {
    providerTurn = async (_args, emit) => {
      for (const event of [...tool("Bash"), reply("测试都过了")]) emit(event);
    };
    await svc.send(CODEX, { text: "跑测试", displayText: "跑测试", clientMessageId: "cm-user" });
    const [started] = ofType("session_started");
    expect(started).toMatchObject({ trigger: "user", clientMessageId: "cm-user" });
    const [complete] = ofType("turn_complete");
    expect(complete).toMatchObject({
      reason: "completed",
      text: "测试都过了",
      runId: started!.runId,
      clientMessageId: "cm-user",
      outcome: { didWork: true, backgroundPending: false, trigger: "user" },
    });
    // Every event of the run carries its identity, as native ChatSession stamps it.
    expect(ofType("tool_use_start")[0]).toMatchObject({ runId: started!.runId });
    // Stamped before journaling: Main deduplicates late notifications by content.
    const journal = readOutputJournal(sessionsRoot(), CODEX);
    const { outputCursor: _cursor, ...live } = complete!;
    expect(journal.frames.find((frame) => frame.event.type === "turn_complete")?.event).toEqual(
      live,
    );
  });

  test("a second run names the run it replaced; a host message says so", async () => {
    await svc.send(CODEX, { text: "第一轮" });
    await svc.send(CODEX, {
      text: "Mimi 转来的",
      displayText: "Mimi 转来的",
      trigger: "host_message",
    });
    const [first, second] = ofType("session_started");
    expect(second).toMatchObject({ trigger: "host_message", previousRunId: first!.runId });
  });

  test("a run carries a message id only when its message was announced", async () => {
    providerTurn = async (_args, emit) => {
      for (const event of [...tool("Bash"), reply("好了")]) emit(event);
    };
    // The renderer's own send has its bubble already; nothing was published for it.
    await svc.send(CODEX, { text: "跑测试", clientMessageId: "cm-renderer" });
    expect(published.filter((event) => event.clientMessageId !== undefined)).toEqual([]);
    // An unannounced host message would have its run folded out of view; the
    // refusal is a rejected promise, never a synchronous throw at the caller.
    const refused = svc.send(CODEX, {
      text: "Mimi 转来的",
      clientMessageId: "cm-mimi",
      trigger: "host_message",
    });
    await expect(refused).rejects.toThrow(/displayText/);
    published.length = 0;
    await svc.send(CODEX, {
      text: "Mimi 转来的",
      displayText: "Mimi 转来的",
      clientMessageId: "cm-mimi",
      trigger: "host_message",
    });
    expect(ofType("turn_complete")[0]).toMatchObject({ clientMessageId: "cm-mimi" });
    // Live: the run is folded under Mimi's message, not dropped.
    expect(rendered(published).slice(0, 2)).toMatchObject([
      { kind: "user", text: "Mimi 转来的", clientMessageId: "cm-mimi" },
      { kind: "tool", toolName: "Bash", status: "succeeded" },
    ]);
  });

  test("Goal rounds keep the prompt: hidden continuations keep their own (no) message id", async () => {
    providerTurn = async (_args, emit) => {
      for (const event of [...tool("Bash", `call-${Math.random()}`), reply("round")]) emit(event);
    };
    await svc.send(CODEX, {
      text: "做迁移",
      displayText: "做迁移",
      clientMessageId: "cm-1",
      goal: { objective: "迁移", maxTurns: 3 },
    });
    const frames = readOutputJournal(sessionsRoot(), CODEX).frames.map((frame) => frame.event);
    const users = frames.filter((event) => event.type === "session_user_message");
    expect(users.map((event) => [event.injected === true, event.clientMessageId])).toEqual([
      [false, "cm-1"],
      [true, undefined],
      [true, undefined],
    ]);
    // A reload replays the journal: the owner's prompt is still there.
    const messages = rendered(frames);
    expect(
      messages.filter((message) => message.kind === "user" && !message.injected),
    ).toMatchObject([{ text: "做迁移", clientMessageId: "cm-1" }]);
    expect(messages.filter((message) => message.kind === "tool")).toHaveLength(3);
  });

  test("triggers follow native core: wakes are background_wake, a Goal resume has none", () => {
    expect(externalRunTrigger({}, false)).toBe("user");
    expect(externalRunTrigger({ injected: true }, false)).toBeUndefined();
    expect(externalRunTrigger({ injected: true }, true)).toBe("background_wake");
    const envelope = new ExternalRunEnvelope(() => false);
    envelope.open("background_wake");
    envelope.prepare({ type: "session_started", sessionId: CODEX, runId: "r", promptTokens: 0 });
    // A wake acts on finished work, so it counts as work even without a tool.
    expect(envelope.prepare({ type: "turn_complete", reason: "completed" })).toMatchObject({
      runId: "r",
      outcome: { didWork: true, trigger: "background_wake" },
    });
    // Closed: a late event of no open run passes through unstamped.
    expect(envelope.prepare({ type: "turn_complete", reason: "completed" })).toEqual({
      type: "turn_complete",
      reason: "completed",
    });
  });

  test("a run parks for background work it started, not for an earlier run's", async () => {
    const outcomes = deriveAll();
    providerTurn = async (_args, emit) => {
      for (const event of tool("DriveAgent")) emit(event);
      backgroundRunning = true;
    };
    await svc.send(CODEX, { text: "后台跑评审" });
    // The same work still runs: this run did not start it.
    providerTurn = async (_args, emit) => {
      for (const event of [...tool("Bash"), reply("另一个问题的答案")]) emit(event);
    };
    await svc.send(CODEX, { text: "顺便问一句" });
    expect(
      ofType("turn_complete").map((event) => [
        event.completionKind,
        event.outcome?.backgroundPending,
      ]),
    ).toEqual([
      ["background_wait", true],
      [undefined, false],
    ]);
    expect(outcomes.filter((outcome) => outcome.final).map((outcome) => outcome.kind)).toEqual([
      "waiting-worker",
      "done",
    ]);
    // The persisted state agrees with the stream (task inbox, session list).
    const state = new SessionManager().readSessionState(CODEX);
    expect(state?.lastCompletionKind).toBeUndefined();
    providerTurn = async (_args, emit) => {
      for (const event of tool("DriveAgent", "call-again")) emit(event);
      backgroundRunning = true;
    };
    backgroundRunning = false;
    await svc.send(CODEX, { text: "再后台跑一次" });
    expect(new SessionManager().readSessionState(CODEX)?.lastCompletionKind).toBe(
      "background_wait",
    );
  });
});

describe("outcomes of external runs", () => {
  test("a turn that only arranged a notice is idle, not done", async () => {
    const outcomes = deriveAll();
    providerTurn = async (_args, emit) => {
      for (const event of [...tool("ToolSearch"), ...tool("NotifyMe"), reply("好的，做完告诉你")])
        emit(event);
    };
    await svc.send(CODEX, { text: "做完微信告诉我" });
    expect(ofType("turn_complete")[0]?.outcome?.didWork).toBe(false);
    expect(outcomes.filter((outcome) => outcome.final)).toMatchObject([
      { kind: "idle", summary: "好的，做完告诉你" },
    ]);
  });

  test("a working turn is done, with its final reply", async () => {
    const outcomes = deriveAll();
    providerTurn = async (_args, emit) => {
      for (const event of [reply("先看看。"), ...tool("commandExecution"), reply("修好了")])
        emit(event);
    };
    await svc.send(CODEX, { text: "修登录" });
    const [started] = ofType("session_started");
    expect(outcomes.filter((outcome) => outcome.final)).toMatchObject([
      {
        kind: "done",
        scope: "turn",
        runId: started!.runId,
        reply: true,
        // The final answer, after the last tool call (narration before it is not).
        replyText: "修好了",
        summary: "修好了",
      },
    ]);
  });

  /** The closing outcome is blocked on the limit; nothing asked the owner a question. */
  function expectLimitBlocked(outcomes: readonly SessionOutcome[]) {
    expect(svc.getGoal(CODEX)).toMatchObject({ paused: true });
    expect(outcomes.filter((outcome) => outcome.kind === "blocked" || outcome.final)).toMatchObject(
      [{ kind: "blocked", reason: "limit", final: true }],
    );
    expect(outcomes.at(-1)).not.toHaveProperty("repeat");
    expect(ofType("goal_progress").some((event) => event.waitingForUser !== undefined)).toBe(false);
    expect(ofType("turn_complete")).toMatchObject([
      {
        reason: "completed",
        completionKind: "limit_stop",
        outcome: { blockedOn: "limit", goal: "paused" },
      },
    ]);
  }

  test("a Goal paused on its turn limit is blocked on the limit, and the owner is told", async () => {
    current = noticeHarness();
    await current.handler(
      CODEX,
      upsertArgs({ sessionId: CODEX, scope: "goal", events: ["blocked"] }),
    );
    env.clock = NOW + 1_000;
    const deriver = new SessionOutcomeDeriver();
    const outcomes: SessionOutcome[] = [];
    const notices = sink;
    sink = (sessionId, event) => {
      outcomes.push(...deriver.derive(sessionId, event));
      notices(sessionId, event);
    };
    providerTurn = async (_args, emit) => {
      for (const event of [...tool("commandExecution"), reply("还差一点")]) emit(event);
    };
    await svc.send(CODEX, { text: "做完整个迁移", goal: { objective: "迁移", maxTurns: 1 } });
    expectLimitBlocked(outcomes);
    await settle(() => current!.submitted.length > 0);
    expect(current.submitted).toMatchObject([{ kind: "session.blocked", sessionId: CODEX }]);
  });

  test("a Goal out of time is blocked on the limit, not aborted by its interrupt", async () => {
    const outcomes = deriveAll();
    providerTurn = async (_args, emit) => {
      for (const event of tool("commandExecution")) emit(event);
      await untilInterrupted(emit);
    };
    await svc.send(CODEX, { text: "迁移", goal: { objective: "迁移", timeBudgetMs: 30 } });
    expectLimitBlocked(outcomes);
  });

  test("a Goal out of tokens is blocked on the limit, not aborted by its interrupt", async () => {
    const outcomes = deriveAll();
    providerTurn = async (_args, emit) => {
      for (const event of tool("commandExecution")) emit(event);
      emit({ type: "usage_update", promptTokens: 500, completionTokens: 100 });
      await untilInterrupted(emit);
    };
    await svc.send(CODEX, { text: "迁移", goal: { objective: "迁移", tokenBudget: 100 } });
    expectLimitBlocked(outcomes);
  });

  test("a Stop the owner asked for pauses the Goal without asking anything", async () => {
    const outcomes = deriveAll();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    providerTurn = async () => held;
    const running = svc.send(CODEX, { text: "做迁移", goal: { objective: "迁移" } });
    await settle(() => svc.isRunActive(CODEX));
    await svc.interrupt(CODEX);
    release();
    await running;
    expect(outcomes.some((outcome) => outcome.kind === "blocked")).toBe(false);
    expect(outcomes.filter((outcome) => outcome.final)).toMatchObject([{ kind: "aborted" }]);
  });

  test("cancel_goal cancels the Goal's rules and the run's close is no done", async () => {
    current = noticeHarness();
    await current.handler(CODEX, upsertArgs({ sessionId: CODEX, scope: "goal" }));
    env.clock = NOW + 1_000;
    providerTurn = async (args, emit) => {
      for (const event of tool("commandExecution")) emit(event);
      await (args.registry as ToolRegistry).executeTool("cancel_goal", {
        ...goalIdentity(),
        confirm: true,
        reason: "用户不要了",
      });
    };
    await svc.send(CODEX, { text: "迁移", goal: { objective: "迁移" } });
    const rules = current.wiring.ruleStore;
    await settle(() => rules.list().some((rule) => rule.state === "cancelled"));
    expect(rules.list().map((rule) => [rule.when, rule.state])).toEqual([
      [expect.objectContaining({ scope: "goal" }), "cancelled"],
    ]);
    // Like native core's goal_control_stop: the close restates the clear, it is not a done.
    expect(ofType("turn_complete").at(-1)).toMatchObject({ completionKind: "goal_control_stop" });
    const deriver = new SessionOutcomeDeriver();
    const outcomes = published.flatMap((event) => deriver.derive(CODEX, event));
    expect(outcomes.filter((outcome) => outcome.kind !== "idle")).toMatchObject([
      { kind: "cancelled", final: false },
      { kind: "cancelled", final: true, repeat: true },
    ]);
    await settle();
    expect(current.submitted).toEqual([]);
  });

  test("a done notice goes out for an external Session with its reply", async () => {
    current = noticeHarness();
    await current.handler(CODEX, upsertArgs({ sessionId: CODEX }));
    env.clock = NOW + 1_000;
    providerTurn = async (_args, emit) => {
      for (const event of [...tool("commandExecution"), reply("登录修好了")]) emit(event);
    };
    await svc.send(CODEX, { text: "修登录" });
    await settle(() => current!.submitted.length > 0);
    expect(current.submitted).toMatchObject([{ kind: "session.done", sessionId: CODEX }]);
  });
});

describe("the external stream feeding the tap", () => {
  /** AgentBridge's two Session streams, driven by hand. */
  function sources() {
    const external = new Set<
      Parameters<SessionOutcomeSources["subscribeExternalSessionStream"]>[0]
    >();
    const source: SessionOutcomeSources = {
      subscribeOutbound: () => () => undefined,
      subscribeExternalSessionStream: (listener) => {
        external.add(listener);
        return () => external.delete(listener);
      },
    };
    return {
      source,
      event: (sessionId: string, event: unknown) => {
        for (const listener of external) listener.event(sessionId, event);
      },
      released: (sessionId: string) => {
        for (const listener of external) listener.released(sessionId);
      },
    };
  }

  test("a runtime released mid-run sends the report parked on its open run", async () => {
    current = noticeHarness();
    const bridge = sources();
    const stop = feedSessionOutcomeTap({
      sources: bridge.source,
      observe: current.observeSessionEvent,
      deriver: current.deriver,
      runtimeEnded: current.wiring.externalRuntimeEnded,
    });
    current.routes.push({ ...boundRoute(), sessionId: CODEX });
    await current.handler(CODEX, upsertArgs({ sessionId: CODEX, events: ["failed"] }));
    env.clock = NOW + 1_000;
    bridge.event(CODEX, { type: "session_started", runId: "run-1", trigger: "user" });
    bridge.event(CODEX, { type: "tool_use_start", toolCall: { id: "t", toolName: "Bash" } });
    // A failure inside the run: its report waits for the run's close.
    bridge.event(CODEX, { type: "error", error: "boom", runId: "run-1" });
    await settle();
    expect(current.submitted).toEqual([]);
    // The runtime goes away without a terminal (its output could not be published).
    bridge.released(CODEX);
    await settle(() => current!.submitted.length > 0);
    expect(current.submitted.map((notice) => notice.dedupeKey)).toEqual([`${CODEX}:failed:run-1`]);
    stop();
    bridge.event(CODEX, { type: "session_started", runId: "run-2" });
    expect(current.deriver.derive(CODEX, { type: "turn_complete", reason: "completed" })).toEqual([
      expect.objectContaining({ kind: "idle", runKey: expect.not.stringMatching(/run-2/) }),
    ]);
  });

  test("a released runtime forgets only its own open turn", () => {
    const deriver = new SessionOutcomeDeriver();
    const bridge = sources();
    const ended: string[] = [];
    feedSessionOutcomeTap({
      sources: bridge.source,
      observe: (sessionId, event) => deriver.derive(sessionId, event),
      deriver,
      runtimeEnded: (sessionId) => ended.push(sessionId),
    });
    for (const id of [CODEX, "s-other"]) {
      bridge.event(id, { type: "session_started", runId: `run-${id}` });
      bridge.event(id, { type: "tool_use_start", toolCall: { id: "t", toolName: "Bash" } });
    }
    bridge.released(CODEX);
    expect(ended).toEqual([CODEX]);
    const close = { type: "turn_complete", reason: "completed" };
    expect(deriver.derive("s-other", close)).toMatchObject([
      { kind: "done", runId: "run-s-other" },
    ]);
    expect(deriver.derive(CODEX, close)).toMatchObject([{ kind: "idle" }]);
    expect(deriver.derive(CODEX, close)[0]?.runId).toBeUndefined();
  });
});

/** One tool call through the Session tool host the provider's bridge would build. */
async function viaToolHost(args: StartArgs, name: string, input: Record<string, unknown>) {
  const { hooks: _hooks, ...options } = args as StartArgs & { hooks?: unknown };
  const reviewed = deriveExternalToolExposure(args.registry, {
    goalController: args.goalController,
    mimiHost: args.mimiHost,
  });
  const host = createSessionToolHost({
    ...(options as unknown as Parameters<typeof createSessionToolHost>[0]),
    exposure: intersectExternalToolExposure(reviewed, args.exposure),
  });
  try {
    return await host.execute({ id: `call-${name}`, name, input });
  } finally {
    await host.dispose();
  }
}

describe("Mimi's tools in an external Session", () => {
  test("NotifyMe and ReportToMimi are advertised, allowed without approval, with guidance", () => {
    const args = lastStart!;
    expect(args.mimiHost).toBe(true);
    expect([...args.exposure!.toolNames]).toEqual(
      expect.arrayContaining(["NotifyMe", "ReportToMimi"]),
    );
    for (const tool of ["NotifyMe", "ReportToMimi"])
      expect(args.presetRules).toContainEqual({ tool, decision: "allow" });
    expect(args.developerInstructions).toContain("call NotifyMe once");
  });

  test("without Main's handlers, or with Host tools off, there are none", async () => {
    for (const flags of [
      { external_agent_runtime: true, external_host_tools: true },
      { external_agent_runtime: true, external_host_tools: false },
    ]) {
      let consulted = false;
      const plain = new ExternalRuntimeService({
        featureFlags: () => flags,
        registerSession: () => {},
        releaseSession: () => {},
        resolveProjectBinding: () => undefined,
        emit: () => undefined,
        projectTrust: () => "untrusted",
        prepareCodexLaunch: async () => ({ command: "/fixture/codex", env: { PATH: "/fixture" } }),
        startSession,
        ...(flags.external_host_tools
          ? {}
          : {
              mimiTools: () => {
                consulted = true;
                return { report: () => undefined };
              },
            }),
      });
      try {
        await plain.start({ kind: "codex", sessionId: "s-codex-plain", cwd });
        expect(lastStart!.mimiHost).toBe(false);
        expect(lastStart!.exposure!.toolNames.has("NotifyMe")).toBe(false);
        expect(lastStart!.registry.getTool("NotifyMe")).toBeUndefined();
        expect(lastStart!.developerInstructions).not.toContain("NotifyMe");
        expect(consulted).toBe(false);
      } finally {
        await plain.stopAll();
      }
    }
  });

  test("NotifyMe saves the rule for this Session; the turn that only did that is idle", async () => {
    current = noticeHarness();
    const outcomes: SessionOutcome[] = [];
    const deriver = new SessionOutcomeDeriver();
    const notices = sink;
    sink = (sessionId, event) => {
      outcomes.push(...deriver.derive(sessionId, event));
      notices(sessionId, event);
    };
    let text = "";
    providerTurn = async (args, emit) => {
      const result = await viaToolHost(args, "NotifyMe", { channel: "wechat" });
      expect(result.isError).toBeFalsy();
      text = String(result.result);
      for (const event of [...tool("NotifyMe"), reply("好的，做完微信告诉你")]) emit(event);
    };
    await svc.send(CODEX, { text: "做完微信告诉我" });
    expect(text).toContain("saved: the owner will be told");
    expect(text).toContain("微信 (wechat, ready)");
    expect(current.wiring.ruleStore.activeForSession(CODEX)).toMatchObject([
      { when: { kind: "session", sessionId: CODEX, scope: "turn" }, channel: "wechat" },
    ]);
    expect(outcomes.filter((outcome) => outcome.final)).toMatchObject([{ kind: "idle" }]);
  });

  test("in a Goal run the rule defaults to the Goal", async () => {
    current = noticeHarness();
    providerTurn = async (args, emit) => {
      expect((await viaToolHost(args, "NotifyMe", {})).isError).toBeFalsy();
      for (const event of [...tool("commandExecution"), reply("还差一点")]) emit(event);
    };
    await svc.send(CODEX, { text: "做迁移，做完告诉我", goal: { objective: "迁移", maxTurns: 1 } });
    expect(current.wiring.ruleStore.activeForSession(CODEX)).toMatchObject([
      { when: { scope: "goal" } },
    ]);
  });

  test("a rule Main refuses is reported as not saved", async () => {
    // No notice wiring: Main's handler throws, nothing is stored.
    let result: Awaited<ReturnType<typeof viaToolHost>> | undefined;
    providerTurn = async (args) => {
      result = await viaToolHost(args, "NotifyMe", {});
    };
    await svc.send(CODEX, { text: "做完告诉我" });
    expect(result?.isError).toBe(true);
    expect(String(result?.error)).toContain("the notice rule was not saved (no notice wiring)");
  });

  test("ReportToMimi reaches Main's report observer as this Session", async () => {
    providerTurn = async (args) => {
      expect(
        (await viaToolHost(args, "ReportToMimi", { message: "迁移做完了" })).isError,
      ).toBeFalsy();
    };
    await svc.send(CODEX, { text: "做完跟 Mimi 说一声" });
    expect(reports).toMatchObject([{ sessionId: CODEX, message: "迁移做完了" }]);
  });
});

describe("long tasks Mimi hands to an external Session", () => {
  test("the run binds to its task by the submission's client message id and closes it", async () => {
    const store = new PetLongTaskStore(join(home, "tasks.json"), () => Date.now());
    const snapshot: DesktopPetProjectionSnapshot = {
      version: 1,
      generation: 1,
      workerState: "active",
      sessions: [],
      pending: [],
      observedAt: 0,
      workMemorySegments: [],
    };
    const closed: PetLongTask[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const runs: Promise<unknown>[] = [];
    const coordinator: PetLongTaskCoordinator = new PetLongTaskCoordinator({
      store,
      projection: { getSnapshot: () => snapshot, subscribe: () => () => undefined },
      worker: {
        hasLiveWorker: () => false,
        requestWorker: async () => ({ ok: false as const, message: "no worker" }),
      },
      launcher: {
        start: async (delegation) => {
          // What a dispatch into this runtime submits: the task's own message id.
          runs.push(
            svc.send(CODEX, {
              text: delegation.task,
              displayText: delegation.task,
              clientMessageId: petDelegationClientMessageId(delegation.clientMessageId),
              trigger: "host_message",
            }),
          );
          return { sessionId: CODEX, cwd };
        },
      },
      onTaskClosed: async (task) => {
        closed.push(task);
      },
    });
    await coordinator.start();
    const deriver = new SessionOutcomeDeriver();
    const observed: Promise<void>[] = [];
    sink = (sessionId, event) =>
      observed.push(
        coordinator.observeSessionEvent(sessionId, event, deriver.derive(sessionId, event)),
      );
    providerTurn = async (_args, emit) => {
      await held;
      for (const event of [...tool("commandExecution"), reply("登录修好了")]) emit(event);
    };
    const launch = await coordinator.startDelegation({
      clientMessageId: "mimi-turn-1",
      task: "修登录",
      workspacePath: cwd,
      targetSessionId: CODEX,
    });
    release();
    await Promise.all(runs);
    await Promise.all(observed);
    const [started] = ofType("session_started");
    expect(store.get(launch.taskId!)).toMatchObject({
      runId: started!.runId,
      status: "completed",
      resultSummary: "登录修好了",
    });
    expect(closed.map((task) => task.id)).toEqual([launch.taskId]);
  });
});
