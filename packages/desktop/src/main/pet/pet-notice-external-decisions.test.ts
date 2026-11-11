/**
 * Decision prompts for desktop external runtimes (Codex / Claude Code in
 * Main): the real ExternalRuntimeApprovals (with a fake window) feeds the real
 * notice wiring and PetImDecisions, as main wires them.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ExternalRuntimeApprovals,
  type ExternalApprovalDecision,
  type ExternalApprovalEvent,
  type ExternalApprovalRequest,
} from "../external-runtime-approvals.js";
import { collectImDecisions, PetImDecisions, type ImDecision } from "./pet-im-decisions.js";
import {
  externalDecisionCode,
  externalDecisionRequest,
  withExternalDecisions,
} from "./pet-notice-external-decisions.js";
import type { ExternalNoticeSessionCatalog } from "./pet-notice-external-sessions.js";
import type { PetNoticeWiringDeps } from "./pet-notice-wiring.js";
import type { DesktopPendingDecision } from "./pet-state-aggregator.js";
import {
  cleanupNoticeEnv,
  env,
  fakeTimers,
  harness,
  OWNER_DM,
  resetNoticeEnv,
  SETTINGS_TTL,
  settle,
  SID,
  upsertArgs,
  type Harness,
} from "./test-utils/notice-wiring-harness.js";

/** A desktop Codex Session: the worker projection never lists it. */
const XID = "s-codex";

const catalog: ExternalNoticeSessionCatalog = {
  get: (id) => (id === XID ? { sessionId: XID, title: "Codex 修 CI", busy: false } : undefined),
  has: (id) => id === XID,
  isLive: (id) => id === XID,
};

let current: Harness | undefined;
let approvals: ExternalRuntimeApprovals | undefined;
let relay: PetImDecisions | undefined;

beforeEach(resetNoticeEnv);

afterEach(async () => {
  relay?.stop();
  approvals?.cancelSession(XID);
  await cleanupNoticeEnv(current);
  current = undefined;
  approvals = undefined;
  relay = undefined;
});

function setup(
  options: {
    timeoutMs?: number;
    overrides?: Partial<PetNoticeWiringDeps>;
    relay?: Partial<ConstructorParameters<typeof PetImDecisions>[0]>;
  } = {},
) {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const window = {
    isDestroyed: () => false,
    webContents: {
      id: 1,
      send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
    },
  };
  const router = new ExternalRuntimeApprovals({
    windows: () => [window] as never,
    now: () => env.clock,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  approvals = router;
  const resolutions: ExternalApprovalEvent[] = [];
  router.subscribe((event) => void (event.type === "resolved" && resolutions.push(event)));
  const h = harness({
    externalSessions: catalog,
    externalApprovals: { approvals: () => router, subscribe: (l) => router.subscribe(l) },
    ...options.overrides,
  });
  current = h;
  /** Native worker requests, as `decisionRelay` raises them. */
  const lines: string[] = [];
  const nativeAnswers: unknown[] = [];
  const timers = fakeTimers();
  let nativeReadFails = false;
  const readFailures: string[] = [];
  const decisions = new PetImDecisions({
    ...withExternalDecisions(
      h.wiring.externalDecisions,
      {
        read: () => {
          if (nativeReadFails) throw new Error("projection unreadable");
          return collectImDecisions(h.snapshot(), h.tasks, lines, h.wiring.decisions.deliveryFor);
        },
        approve: async (_entry, decision) => void nativeAnswers.push(decision),
      },
      (source) => readFailures.push(source),
    ),
    now: () => env.clock,
    router: h.wiring.router,
    isOwnerConversation: h.wiring.decisions.isOwnerConversation,
    ownerChannelIsDirect: h.wiring.decisions.ownerChannelIsDirect,
    isAway: h.wiring.decisions.isAway,
    decisionStatus: h.wiring.decisions.decisionStatus,
    projectionLive: h.wiring.decisions.projectionLive,
    workerGone: h.wiring.decisions.workerGone,
    projection: { subscribe: h.subscribeProjection },
    nudges: [h.wiring.decisions.onBlocked],
    onAwayChange: h.wiring.decisions.onAwayChange,
    sweepMs: 0,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    onError: (error) => {
      throw error;
    },
    ...options.relay,
  });
  relay = decisions;
  decisions.start();

  /** One external prompt; resolves with what the runtime is told. */
  const ask = (request: ExternalApprovalRequest, sessionId = XID) => {
    const decision = router.request(sessionId, request);
    const requestId = (sent.at(-1)!.payload as { requestId: string }).requestId;
    return { decision, requestId, code: externalDecisionCode(sessionId, requestId) };
  };
  /** Past the grace period: the prompt goes out. */
  const graceOver = async (until?: () => boolean) => {
    env.clock += 16_000;
    await decisions.scan();
    await settle(until, () => decisions.scan());
  };
  const raiseNative = (requestId = "req-1") => {
    const pending = {
      agentSessionId: SID,
      requestId,
      routeGeneration: 1,
      workerGeneration: 1,
      kind: "tool_approval",
      title: "等待批准 Bash",
      createdAt: env.clock,
      status: "pending",
    } as DesktopPendingDecision;
    h.pending.push(pending);
    lines.push(
      JSON.stringify({
        method: "agent/approvalRequest",
        params: {
          sessionId: SID,
          requestId,
          connectionId: "worker",
          generation: 1,
          request: { toolName: "Bash", description: "List files", args: { command: "ls" } },
        },
      }),
    );
    h.emitProjection({
      kind: "pending-upsert",
      pending,
      version: 2,
      generation: 1,
      observedAt: env.clock,
    });
  };
  const promptOf = (code: string) =>
    h.wiring.ledger.prompts().find((record) => record.prompt?.code === code)?.prompt;
  const reply = (message: string) => decisions.reply({ message, origin: OWNER_DM });
  return {
    h,
    router,
    sent,
    timers,
    ask,
    graceOver,
    raiseNative,
    promptOf,
    reply,
    nativeAnswers,
    decisions,
    resolutions,
    readFailures,
    failNativeReads: (fails: boolean) => void (nativeReadFails = fails),
  };
}

const bash: ExternalApprovalRequest = {
  toolName: "Bash",
  args: { command: "rm -rf build" },
  description: "Run a shell command",
  riskLevel: "high",
};

function question(args: Record<string, unknown>): ExternalApprovalRequest {
  return {
    toolName: "__ask_user__",
    args,
    description: String(args.question),
    riskLevel: "low",
  };
}

async function watchBlocked(sessionId = XID) {
  await current!.handler(sessionId, upsertArgs({ sessionId, events: ["blocked"] }));
}

describe("external runtime decision prompts", () => {
  test("an approval becomes one session.blocked prompt with its own code, answered by 回答 码 1", async () => {
    const t = setup();
    await watchBlocked();
    const { decision, requestId, code } = t.ask(bash);
    await settle();
    // Grace first, as for worker requests.
    expect(t.h.ownerSends).toEqual([]);
    await t.graceOver(() => t.h.ownerSends.length > 0 && t.promptOf(code)?.phase === "im");
    expect(t.h.ownerSends).toHaveLength(1);
    const text = t.h.ownerSends[0]!.text;
    expect(text).toContain(`回答 ${code} 1`);
    expect(text).toContain("rm -rf build");
    // One session.blocked record (the single path rule-watched decisions take).
    const records = t.h.wiring.ledger.forRequest(XID, requestId);
    expect(records).toEqual([
      expect.objectContaining({ kind: "session.blocked", priority: "P0", sessionId: XID }),
    ]);
    expect(records[0]!.facts).toMatchObject({ title: "Codex 修 CI", code });

    expect(await t.reply(`回答 ${code} 1`)).toContain("已处理");
    await expect(decision).resolves.toEqual({ approved: true });
    expect(t.router.pendingAll()).toEqual([]);
    await settle(() => t.promptOf(code)?.phase === "answered");
    expect(t.promptOf(code)?.phase).toBe("answered");
    expect(await t.reply(`回答 ${code} 1`)).toContain("已结束");
    expect(t.h.ownerSends).toHaveLength(1);
  });

  test("回答 码 拒绝 denies the call", async () => {
    const t = setup();
    await watchBlocked();
    const { decision, code } = t.ask(bash);
    await t.graceOver(() => t.promptOf(code)?.phase === "im");
    expect(await t.reply(`回答 ${code} 拒绝`)).toContain("本次操作未授权");
    await expect(decision).resolves.toEqual({
      approved: false,
      reason: "User declined via the originating IM conversation",
    });
  });

  test("拒绝 on a question skips it, and says so", async () => {
    const t = setup();
    await watchBlocked();
    const { decision, code } = t.ask(question({ question: "分支叫什么？" }));
    await t.graceOver(() => t.promptOf(code)?.phase === "im");
    const text = await t.reply(`回答 ${code} 拒绝`);
    expect(text).toContain("已跳过这个问题");
    expect(text).not.toContain("未授权");
    await expect(decision).resolves.toMatchObject({ approved: false });
  });

  test("only the owner's private chat answers an external code; another Session's prompt is never settled", async () => {
    const t = setup();
    await watchBlocked();
    const { decision, requestId, code } = t.ask(bash);
    await t.graceOver(() => t.promptOf(code)?.phase === "im");
    const other = { ...OWNER_DM, target: "someone-else" };
    expect(await t.decisions.reply({ message: `回答 ${code} 1`, origin: other })).toContain(
      "不属于当前私聊",
    );
    expect(
      await t.decisions.reply({
        message: `回答 ${code} 1`,
        origin: { ...OWNER_DM, isDirectMessage: false },
      }),
    ).toContain("不属于当前私聊");
    expect(await t.decisions.reply({ message: `回答 ${code} 1` })).toContain("不属于当前私聊");
    expect(t.router.pendingAll()).toHaveLength(1);
    // An entry claiming another Session for this request id settles nothing.
    const [entry] = t.h.wiring.externalDecisions.read();
    const forged = { ...entry!, envelope: { ...entry!.envelope, sessionId: SID } };
    await expect(t.h.wiring.externalDecisions.approve(forged, { approved: true })).rejects.toThrow(
      "no longer pending",
    );
    expect(t.router.pendingAll().map((item) => item.requestId)).toEqual([requestId]);
    expect(await t.reply(`回答 ${code} 1`)).toContain("已处理");
    await expect(decision).resolves.toEqual({ approved: true });
  });

  test("after a restart an open external prompt ends revoked, with no 已超时", async () => {
    const before = setup();
    await watchBlocked();
    const { code } = before.ask(bash);
    await before.graceOver(() => before.promptOf(code)?.phase === "im");
    // Shutdown: the prompts stop first, then the runtime cancels its prompts.
    before.decisions.stop();
    before.router.cancelSession(XID);
    await before.h.wiring.flush();
    before.h.wiring.dispose();
    current = undefined;

    env.clock += 20 * 60_000;
    const t = setup();
    await t.h.wiring.ready;
    await t.decisions.scan();
    await settle(() => t.promptOf(code)?.phase === "revoked");
    expect(t.promptOf(code)?.phase).toBe("revoked");
    expect(t.promptOf(code)?.expiryNotice).toBeUndefined();
    await settle();
    expect(t.h.ownerSends).toEqual([]);
  });

  test("without a rule or an IM task the decision stays on the desktop", async () => {
    const t = setup();
    const { code } = t.ask(bash);
    await t.graceOver();
    expect(t.h.ownerSends).toEqual([]);
    expect(t.promptOf(code)).toBeUndefined();
  });

  test("answered on the desktop first: the prompt ends and its queued copy is withdrawn", async () => {
    const t = setup();
    await watchBlocked();
    t.h.outbox.hold = true;
    const { decision, requestId, code } = t.ask(bash);
    await t.graceOver(() => t.h.ownerSends.length > 0);
    expect(t.router.settle(requestId, { approved: true }, 1)).toBe(true);
    await expect(decision).resolves.toEqual({ approved: true });
    await settle(() => t.promptOf(code)?.phase === "answered" && t.h.outbox.revoked.length > 0);
    expect(t.promptOf(code)?.phase).toBe("answered");
    expect(new Set(t.h.outbox.revoked).size).toBe(1);
    expect(await t.reply(`回答 ${code} 1`)).toContain("已结束");
    // No "已超时": it was answered.
    expect(t.h.ownerSends).toHaveLength(1);
  });

  test("the deadline auto-denies a prompt that reached IM and says so there once", async () => {
    const t = setup({ timeoutMs: 10 * 60_000 });
    await watchBlocked();
    const { decision, code } = t.ask(bash);
    await t.graceOver(() => t.promptOf(code)?.phase === "im");
    t.timers.advance(env.clock + 10 * 60_000);
    await settle(() => t.h.ownerSends.length > 1);
    await expect(decision).resolves.toMatchObject({ approved: false });
    expect(t.h.ownerSends.map((send) => send.text)).toEqual([
      expect.stringContaining(`回答 ${code} 1`),
      expect.stringContaining(`确认 ${code} 已超时`),
    ]);
    await settle(() => t.promptOf(code)?.expiryNotice?.sent === true);
    expect(t.promptOf(code)).toMatchObject({ phase: "expired", expiryNotice: { sent: true } });
    await settle();
    expect(t.h.ownerSends).toHaveLength(2);
    // Mimi's timer won, yet the router records a timeout: desktop and phone say so.
    await expect(decision).resolves.toEqual({ approved: false, reason: "approval timed out" });
    expect(t.resolutions.at(-1)).toMatchObject({ type: "resolved", cause: "timed_out" });
    expect(t.resolutions.at(-1)).not.toHaveProperty("approved");
    expect(t.sent.at(-1)!.payload).not.toHaveProperty("approved");
  });

  test("the runtime's own timeout ends the prompt as expired, with one 已超时 notice", async () => {
    // The router's timer runs on the real clock; the prompt goes out at once.
    const t = setup({ timeoutMs: 40, relay: { graceMs: 0 } });
    await watchBlocked();
    const { decision, code } = t.ask(bash);
    await t.decisions.scan();
    await settle(() => t.promptOf(code)?.phase === "im");
    await expect(decision).resolves.toEqual({ approved: false, reason: "approval timed out" });
    await settle(() => t.promptOf(code)?.expiryNotice?.sent === true);
    expect(t.promptOf(code)).toMatchObject({ phase: "expired", expiryNotice: { sent: true } });
    expect(t.h.ownerSends.map((send) => send.text)).toEqual([
      expect.stringContaining(`回答 ${code} 1`),
      expect.stringContaining(`确认 ${code} 已超时`),
    ]);
  });

  test("a stopped runtime cancels its prompt: it ends without a timeout notice", async () => {
    const t = setup();
    await watchBlocked();
    const { decision, code } = t.ask(bash);
    await t.graceOver(() => t.promptOf(code)?.phase === "im");
    t.router.cancelSession(XID);
    await expect(decision).resolves.toMatchObject({ approved: false });
    await settle(() => t.promptOf(code)?.phase === "revoked");
    expect(t.promptOf(code)?.phase).toBe("revoked");
    expect(t.h.ownerSends).toHaveLength(1);
    expect(await t.reply(`回答 ${code} 1`)).toContain("已结束");
  });

  test("losing the worker ends the worker's prompt only; the external one stays answerable", async () => {
    const t = setup();
    await watchBlocked();
    await watchBlocked(SID);
    t.raiseNative();
    const { decision, code } = t.ask(bash);
    await t.graceOver(() => t.h.ownerSends.length === 2);
    const nativeCode = t.decisions["options"]
      .read()
      .find((entry) => entry.envelope.sessionId === SID)!.code;
    expect(nativeCode).not.toBe(code);
    await settle(() => t.promptOf(nativeCode)?.phase === "im" && t.promptOf(code)?.phase === "im");

    t.h.pending.splice(0);
    t.h.setWorkerState("reclaimed");
    t.h.emitProjection({
      kind: "worker-state",
      state: "reclaimed",
      version: 4,
      generation: 1,
      observedAt: env.clock,
    } as never);
    await t.decisions.scan();
    await settle(() => t.promptOf(nativeCode)?.phase === "revoked");
    expect(t.promptOf(nativeCode)?.phase).toBe("revoked");
    expect(t.promptOf(code)?.phase).toBe("im");

    expect(await t.reply(`回答 ${code} 1`)).toContain("已处理");
    await expect(decision).resolves.toEqual({ approved: true });
    expect(t.nativeAnswers).toEqual([]);
  });

  test("a prompt queued for an unavailable channel replays while pending, never after", async () => {
    const t = setup();
    t.h.channels[1] = { id: "lark", label: "飞书", ready: "unavailable" };
    await current!.handler(
      XID,
      upsertArgs({ sessionId: XID, events: ["blocked"], channel: "lark" }),
    );
    const origin = { channel: "lark", target: "dm-1", senderId: "owner", isDirectMessage: true };
    const first = t.ask(bash);
    await t.graceOver(() => t.promptOf(first.code) !== undefined);
    expect(t.h.ownerSends).toEqual([]);
    // Still pending in the runtime's router: the worker projection's silence says nothing.
    const replay = t.h.wiring.inboundReplay(origin)!;
    expect(await replay.take()).toEqual([expect.objectContaining({ kind: "session.blocked" })]);
    replay.started();
    replay.finish();

    const second = t.ask({ ...bash, args: { command: "make" } });
    await t.graceOver(() => t.promptOf(second.code) !== undefined);
    expect(t.router.settle(second.requestId, { approved: true }, 1)).toBe(true);
    await settle(() => t.promptOf(second.code)?.phase === "answered");
    const after = t.h.wiring.inboundReplay(origin)!;
    expect(await after.take()).toEqual([]);
    after.finish();
  });

  test("while the worker is down an external prompt still ends as it really did", async () => {
    const t = setup();
    await watchBlocked();
    const first = t.ask(bash);
    const second = t.ask({ ...bash, args: { command: "make" } });
    await t.graceOver(
      () => t.promptOf(first.code)?.phase === "im" && t.promptOf(second.code)?.phase === "im",
    );
    // A missed snapshot (the worker may be alive): no worker request is judged.
    t.h.setWorkerState("disconnected");
    expect(t.router.settle(first.requestId, { approved: true }, 1)).toBe(true);
    await settle(() => t.promptOf(first.code)?.phase === "answered");
    expect(t.promptOf(first.code)?.phase).toBe("answered");
    // The worker really gone: still answered, not revoked with the worker's requests.
    t.h.setWorkerState("reclaimed");
    expect(t.router.settle(second.requestId, { approved: false }, 1)).toBe(true);
    await settle(() => t.promptOf(second.code)?.phase === "answered");
    expect(t.promptOf(second.code)?.phase).toBe("answered");
  });

  test("a stopped runtime never ends the worker's prompt", async () => {
    const t = setup();
    await watchBlocked();
    await watchBlocked(SID);
    t.raiseNative();
    const { code } = t.ask(bash);
    await t.graceOver(() => t.h.ownerSends.length === 2);
    const nativeCode = t.decisions["options"]
      .read()
      .find((entry) => entry.envelope.sessionId === SID)!.code;
    await settle(() => t.promptOf(nativeCode)?.phase === "im");
    t.router.cancelSession(XID);
    await settle(() => t.promptOf(code)?.phase === "revoked");
    expect(t.promptOf(nativeCode)?.phase).toBe("im");
    expect(await t.reply(`回答 ${nativeCode} 1`)).toContain("已处理");
    expect(t.nativeAnswers).toEqual([{ approved: true }]);
  });

  test("a native read that fails still prompts external decisions, and ends no native prompt", async () => {
    const t = setup();
    await watchBlocked();
    await watchBlocked(SID);
    t.raiseNative();
    await t.graceOver(() => t.h.ownerSends.length === 1);
    const nativeCode = t.decisions["options"]
      .read()
      .find((entry) => entry.envelope.sessionId === SID)!.code;
    await settle(() => t.promptOf(nativeCode)?.phase === "im");
    t.failNativeReads(true);
    // Answered on the desktop meanwhile: a read that saw nothing cannot tell.
    t.h.pending.splice(0);
    const { decision, code } = t.ask(bash);
    await t.graceOver(() => t.promptOf(code)?.phase === "im");
    expect(t.h.ownerSends).toHaveLength(2);
    expect(t.promptOf(nativeCode)?.phase).toBe("im");
    expect(t.readFailures[0]).toBe("native");
    expect(await t.reply(`回答 ${code} 1`)).toContain("已处理");
    await expect(decision).resolves.toEqual({ approved: true });
    // Readable again: now its end is known.
    t.failNativeReads(false);
    await t.decisions.scan();
    await settle(() => t.promptOf(nativeCode)?.phase === "revoked");
    expect(t.promptOf(nativeCode)?.phase).toBe("revoked");
  });

  test("a question: 回答 码 N picks the option, multi-select joins several, free text is the answer", async () => {
    const t = setup();
    await watchBlocked();
    const single = t.ask(
      question({
        question: "用哪个包管理器？",
        options: [
          { label: "pnpm", description: "快" },
          { label: "npm", description: "" },
        ],
      }),
    );
    const multi = t.ask(
      question({
        question: "要跑哪些检查？",
        multiSelect: true,
        options: [
          { label: "lint", description: "" },
          { label: "test", description: "" },
        ],
      }),
    );
    const free = t.ask(question({ question: "分支叫什么？" }));
    await t.graceOver(() => t.h.ownerSends.length === 3);
    const texts = t.h.ownerSends.map((send) => send.text).join("\n");
    expect(texts).toContain("用哪个包管理器？");
    expect(texts).toContain("1. pnpm");
    expect(texts).toContain(`回答 ${multi.code} 1,2`);
    expect(texts).toContain(`回答 ${free.code} 你的答案`);
    // Never skippable, never kept waiting: the runtime denies it at its deadline.
    expect(texts).not.toContain("等待");
    expect(await t.reply(`回答 ${single.code} 跳过`)).toContain("不能跳过");
    expect(await t.reply(`回答 ${single.code} 等待`)).toContain("不能改为一直等待");
    expect(t.router.pendingAll()).toHaveLength(3);

    expect(await t.reply(`回答 ${single.code} 2`)).toContain("已处理");
    expect(await t.reply(`回答 ${multi.code} 1,2`)).toContain("已处理");
    expect(await t.reply(`回答 ${free.code} feat/notify`)).toContain("已处理");
    await expect(single.decision).resolves.toEqual({ approved: true, answer: "npm" });
    await expect(multi.decision).resolves.toEqual({ approved: true, answer: "lint, test" });
    await expect(free.decision).resolves.toEqual({ approved: true, answer: "feat/notify" });
  });

  test("a prompt kept on the desktop goes to IM once when the owner leaves (:away)", async () => {
    let present = true;
    const t = setup({
      overrides: {
        presence: {
          getSystemIdleTimeSec: () => (present ? 0 : 3_600),
          hasFocusedWindow: () => present,
        },
      },
    });
    await watchBlocked();
    const { code, requestId } = t.ask(bash);
    await t.graceOver(() => t.promptOf(code) !== undefined);
    expect(t.h.ownerSends).toEqual([]);
    expect(t.promptOf(code)?.phase).toBe("desktop");
    present = false;
    env.clock += SETTINGS_TTL;
    await t.decisions.scan();
    await settle(
      () => t.h.ownerSends.length > 0,
      () => t.decisions.scan(),
    );
    expect(t.h.ownerSends).toHaveLength(1);
    expect(t.h.ownerSends[0]!.text).toContain(`回答 ${code} 1`);
    expect(t.h.wiring.ledger.forRequest(XID, requestId).map((record) => record.dedupeKey)).toEqual([
      `${XID}:${requestId}`,
      `${XID}:${requestId}:away`,
    ]);
  });
});

describe("reading both sources", () => {
  const entry = (sessionId: string, requestId: string) =>
    ({ code: requestId, envelope: { sessionId, requestId } }) as unknown as ImDecision;
  const native = entry(SID, "req-1");
  const external = entry(XID, "external-approval-1");

  test("a source that fails to read is logged and leaves the other's decisions", () => {
    const failing = new Set<string>();
    const failures: Array<[string, string]> = [];
    const source = (name: string, entries: ImDecision[]) => () => {
      if (failing.has(name)) throw new Error(`${name} unreadable`);
      return entries;
    };
    const both = withExternalDecisions(
      {
        read: source("external", [external]),
        approve: async () => undefined,
        isExternal: (sessionId) => sessionId === XID,
      },
      { read: source("native", [native]), approve: async () => undefined },
      (name, error) => failures.push([name, String(error)]),
    );
    expect(both.read()).toEqual([native, external]);
    expect(both.unreadDecisions?.()).toBeUndefined();
    failing.add("native");
    expect(both.read()).toEqual([external]);
    // What the read could not see has not ended.
    const missed = both.unreadDecisions?.();
    expect([missed?.(SID, "req-1"), missed?.(XID, "external-approval-1")]).toEqual([true, false]);
    failing.clear();
    failing.add("external");
    expect(both.read()).toEqual([native]);
    expect(both.unreadDecisions?.()?.(XID, "external-approval-1")).toBe(true);
    failing.add("native");
    expect(both.read()).toEqual([]);
    expect(failures.map(([name]) => name)).toEqual(["native", "external", "native", "external"]);
    expect(failures[0]![1]).toContain("native unreadable");
  });
});

describe("external decision requests as prompts read them", () => {
  test("codes are bound to the Session and request, and differ from a worker request's", () => {
    expect(externalDecisionCode(XID, "external-approval-1")).toMatch(/^[0-9A-F]{12}$/u);
    expect(externalDecisionCode(XID, "external-approval-1")).not.toBe(
      externalDecisionCode(SID, "external-approval-1"),
    );
  });

  test("a Codex native approval without the service's presentation still reads", () => {
    expect(
      externalDecisionRequest({
        toolName: "Codex native tool",
        method: "item/commandExecution/requestApproval",
        params: { threadId: "t", turnId: "u", itemId: "i", kind: "command", command: "npm test" },
      }),
    ).toEqual({
      toolName: "Codex native tool",
      description: "Codex 想执行命令",
      args: { command: "npm test" },
    });
  });

  test("a question is never skippable; Claude Code and host tools keep their args", () => {
    expect(
      externalDecisionRequest({
        toolName: "__ask_user__",
        args: { question: "Q?", skippable: true, autoResolveMs: 5, options: [{ label: "A" }] },
        description: "Q?",
      }),
    ).toEqual({
      toolName: "__ask_user__",
      description: "Q?",
      args: { question: "Q?", options: [{ label: "A" }] },
    });
    expect(
      externalDecisionRequest({ toolName: "__ask_user__", description: "只有描述" }).args,
    ).toEqual({ question: "只有描述" });
    expect(
      externalDecisionRequest({
        toolName: "Claude Code Bash",
        args: { command: "ls" },
        description: "Claude Code wants to use its native Bash tool.",
      }),
    ).toEqual({
      toolName: "Claude Code Bash",
      description: "Claude Code wants to use its native Bash tool.",
      args: { command: "ls" },
    });
    expect(externalDecisionRequest({ toolName: "Write" })).toEqual({ toolName: "Write", args: {} });
  });

  test("an answer for a prompt that already settled throws instead of claiming success", async () => {
    const t = setup();
    await watchBlocked();
    const { requestId, code } = t.ask(bash);
    await t.graceOver(() => t.promptOf(code)?.phase === "im");
    const [entry] = t.h.wiring.externalDecisions.read();
    expect(t.router.settle(requestId, { approved: false } satisfies ExternalApprovalDecision)).toBe(
      true,
    );
    await expect(t.h.wiring.externalDecisions.approve(entry!, { approved: true })).rejects.toThrow(
      "no longer pending",
    );
  });
});
