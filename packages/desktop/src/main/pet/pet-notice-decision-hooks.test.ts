import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import type { PetLongTask } from "@cjhyy/code-shell-pet";
import { PetNoticeLedger } from "./pet-notice-ledger.js";
import type { PetNoticeWiringDeps } from "./pet-notice-wiring.js";
import {
  OWNER_DM,
  SETTINGS_TTL,
  SID,
  cleanupNoticeEnv,
  decisionRelay,
  env,
  fakeTimers,
  harness,
  longTask,
  resetNoticeEnv,
  settle,
  upsertArgs,
  type Harness,
} from "./test-utils/notice-wiring-harness.js";

let current: Harness | undefined;

beforeEach(resetNoticeEnv);

afterEach(async () => {
  await cleanupNoticeEnv(current);
  current = undefined;
});

describe("decision prompts through the router", () => {
  test("a non-IM Session with a blocked rule gets exactly one owner prompt, answered by code", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ events: ["blocked"] }));
    const d = decisionRelay(current);
    d.raise();
    await settle();
    await d.poll(() => current!.ownerSends.length > 0);
    const code = d.code()!;
    await reachedIm(code);
    expect(code).toMatch(/^[0-9A-F]{12}$/u);
    expect(current.ownerSends).toHaveLength(1);
    expect(current.ownerSends[0]!.targetId).toBe("wechat:owner");
    expect(current.ownerSends[0]!.text).toContain("只允许这一次吗？直接回我就行。");
    expect(current.ownerSends[0]!.text).toContain("ls");
    expect(current.published).toEqual([]);
    // The pet's pending peek is the desktop surface; no native notification on top.
    expect(current.desktop).toEqual([]);
    expect(
      await d.relay.reply({ message: `回答 ${code} 1`, origin: { ...OWNER_DM, target: "x" } }),
    ).toBeUndefined();
    expect(await d.relay.reply({ message: `回答 ${code} 1`, origin: OWNER_DM })).toContain(
      "已处理",
    );
    expect(d.approvals).toEqual([{ approved: true }]);
  });

  test("an owner target that is a group gets the generic text: no question, options or code", async () => {
    current = harness();
    current.directTargets.delete("wechat:owner");
    current.channels[0] = { id: "wechat", label: "微信", ready: "ready", targetId: "wechat:owner" };
    await current.handler(SID, upsertArgs({ events: ["blocked"] }));
    const d = decisionRelay(current);
    d.raise();
    await settle();
    await d.poll(() => current!.ownerSends.length > 0);
    expect(current.ownerSends).toHaveLength(1);
    const text = current.ownerSends[0]!.text;
    expect(text).toContain("请打开桌面 Session 处理");
    expect(text).not.toContain(d.code()!);
    expect(text).not.toContain("ls");
    // Nothing answerable went out, so a bare number is ordinary chat.
    expect(await d.relay.reply({ message: "1", origin: OWNER_DM })).toBeUndefined();
  });

  test("a prompt kept on the desktop escalates to IM once when the owner leaves", async () => {
    let present = true;
    current = harness({
      presence: {
        getSystemIdleTimeSec: () => (present ? 0 : 3_600),
        hasFocusedWindow: () => present,
      },
    });
    await current.handler(SID, upsertArgs({ events: ["blocked"] }));
    const d = decisionRelay(current);
    d.raise();
    await settle();
    await d.poll();
    expect(current.ownerSends).toEqual([]);
    present = false;
    env.clock += SETTINGS_TTL;
    await d.poll();
    await d.poll(() => current!.ownerSends.length > 0);
    expect(current.ownerSends).toHaveLength(1);
    expect(current.ownerSends[0]!.text).toContain("只允许这一次吗？直接回我就行。");
    // Answered on the desktop: the escalation record shares the request id and is settled.
    expect(await d.relay.reply({ message: "1", origin: OWNER_DM })).toContain("已处理");
  });

  test("an IM-started task gets its prompt in its own conversation exactly once", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ events: ["blocked"] }));
    current.tasks.push(
      longTask({
        status: "running",
        completedAt: undefined,
        completionTarget: {
          kind: "im-gateway",
          channel: "lark",
          target: "chat-9",
          senderId: "owner-1",
          isDirectMessage: true,
        },
      }),
    );
    const d = decisionRelay(current);
    d.raise();
    await settle();
    await d.poll();
    await d.poll();
    expect(current.ownerSends).toEqual([]);
    expect(current.published).toHaveLength(1);
    expect(current.published[0]).toMatchObject({ target: { channel: "lark", target: "chat-9" } });
    expect(current.published[0]!.text).toContain("只允许这一次吗？直接回我就行。");
    expect(current.desktop).toEqual([]);
  });

  /** Stop this run (stores flushed) and start the next one on the same files. */
  async function restart(overrides: Partial<PetNoticeWiringDeps> = {}): Promise<void> {
    await current!.wiring.flush();
    current!.wiring.dispose();
    current = harness(overrides);
    await current.wiring.ready;
  }
  const promptOf = (code: string | undefined) =>
    current!.wiring.ledger.prompts().find((record) => record.prompt?.code === code)?.prompt;
  /** The send lands before the prompt's record says so: wait for the record. */
  const reachedIm = (code: string | undefined) => settle(() => promptOf(code)?.phase === "im");

  test("a restart during the grace period prompts once, when the grace ends", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ events: ["blocked"] }));
    const raisedAt = env.clock;
    const before = decisionRelay(current);
    before.raise();
    env.clock = raisedAt + 5_000;
    await before.relay.scan();
    expect(current.ownerSends).toEqual([]);
    // Grace has no record: it is derived from the decision's own createdAt.
    expect(current.wiring.ledger.prompts()).toEqual([]);

    await restart();
    const timers = fakeTimers();
    const d = decisionRelay(current, timers);
    d.relay.start();
    d.raise("req-1", raisedAt);
    await settle();
    expect(current.ownerSends).toEqual([]);
    expect(timers.pending()).toContain(raisedAt + 15_000);
    timers.advance(raisedAt + 15_000);
    await settle(() => current!.ownerSends.length > 0);
    await reachedIm(d.code());
    expect(current.ownerSends).toHaveLength(1);
    expect(promptOf(d.code())).toMatchObject({ phase: "im", channel: "wechat" });
    d.relay.stop();
  });

  test("after a restart a prompt that reached IM is not sent again and still times out", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ events: ["blocked"] }));
    const raisedAt = env.clock;
    const before = decisionRelay(current);
    before.raise();
    await settle();
    await before.poll(() => current!.ownerSends.length > 0);
    const code = before.code()!;
    await reachedIm(code);
    expect(promptOf(code)).toMatchObject({ phase: "im", channel: "wechat" });

    await restart();
    const d = decisionRelay(current);
    d.raise("req-1", raisedAt);
    await d.relay.scan();
    expect(current.ownerSends).toEqual([]);
    // The record says the owner's chat got the prompt: it is open there (the model reads it).
    expect(await d.relay.reply({ message: `回答 ${d.code()} 9`, origin: OWNER_DM })).toContain(
      "请回复选项",
    );
    env.clock = raisedAt + 10 * 60_000;
    await d.relay.scan();
    await settle(() => current!.ownerSends.length > 0);
    expect(d.approvals).toEqual([
      expect.objectContaining({ approved: false, failure: "timed_out" }),
    ]);
    expect(current.ownerSends.map((send) => send.text)).toEqual([
      expect.stringContaining("确认已超时"),
    ]);
    expect(promptOf(code)).toMatchObject({
      phase: "expired",
      expiryNotice: { channel: "wechat", sent: true },
    });
  });

  /** A blocked-rule Session whose owner is present: its prompt stays on the desktop. */
  async function desktopKeptPrompt(idle = { sec: 0 }) {
    const presence = { present: true };
    const focus = new EventEmitter();
    const timers = fakeTimers();
    const overrides: Partial<PetNoticeWiringDeps> = {
      presence: {
        getSystemIdleTimeSec: () => (presence.present ? idle.sec : 3_600),
        hasFocusedWindow: () => presence.present,
      },
      focusEvents: focus as unknown as PetNoticeWiringDeps["focusEvents"],
      presenceTimers: timers,
    };
    current = harness(overrides);
    await current.handler(SID, upsertArgs({ events: ["blocked"] }));
    const d = decisionRelay(current, timers);
    d.relay.start();
    const raisedAt = env.clock;
    d.raise();
    await settle();
    timers.advance(raisedAt + 15_000);
    await settle(() => promptOf(d.code()) !== undefined);
    expect(current.ownerSends).toEqual([]);
    expect(promptOf(d.code())).toMatchObject({ phase: "desktop" });
    return { d, presence, focus, timers, overrides, raisedAt };
  }

  test("the owner leaving escalates at once, and a restart never escalates again", async () => {
    const { d, presence, focus, timers, overrides, raisedAt } = await desktopKeptPrompt();
    // No poll: the window losing focus (once it has settled) is the event.
    presence.present = false;
    focus.emit("browser-window-blur");
    timers.advance(env.clock + 1_000);
    await settle(() => current!.ownerSends.length > 0);
    await reachedIm(d.code());
    expect(current!.ownerSends).toHaveLength(1);
    expect(current!.ownerSends[0]!.text).toContain("只允许这一次吗？直接回我就行。");
    expect(promptOf(d.code())).toMatchObject({
      phase: "im",
      channel: "wechat",
      escalatedAt: raisedAt + 16_000,
    });
    d.relay.stop();

    await restart(overrides);
    const again = decisionRelay(current!);
    again.raise("req-1", raisedAt);
    await again.relay.scan();
    await settle();
    expect(current!.ownerSends).toEqual([]);
  });

  test("switching between CodeShell windows is not leaving; a real leave escalates once", async () => {
    const { d, presence, focus, timers } = await desktopKeptPrompt();
    // Blur one window, focus the next within the settle time.
    presence.present = false;
    focus.emit("browser-window-blur");
    timers.advance(env.clock + 300);
    presence.present = true;
    focus.emit("browser-window-focus");
    timers.advance(env.clock + 1_000);
    await settle();
    expect(current!.ownerSends).toEqual([]);
    expect(promptOf(d.code())).toMatchObject({ phase: "desktop" });
    presence.present = false;
    focus.emit("browser-window-blur");
    timers.advance(env.clock + 1_000);
    await settle(() => current!.ownerSends.length > 0);
    focus.emit("browser-window-focus");
    focus.emit("browser-window-blur");
    timers.advance(env.clock + 1_000);
    await settle();
    expect(current!.ownerSends).toHaveLength(1);
    d.relay.stop();
  });

  test("no input for the idle threshold counts as leaving, with no event", async () => {
    const idle = { sec: 0 };
    const { d, presence, timers } = await desktopKeptPrompt(idle);
    // The presence watch looks again when the threshold (120 s) would pass.
    const crossing = timers.pending().find((at) => at > env.clock + 100_000)!;
    expect(crossing).toBeDefined();
    presence.present = false;
    timers.advance(crossing);
    await settle(() => current!.ownerSends.length > 0);
    await reachedIm(d.code());
    expect(current!.ownerSends).toHaveLength(1);
    expect(promptOf(d.code())).toMatchObject({ phase: "im" });
    d.relay.stop();
  });

  test("a listener that subscribes while the owner is already away hears it at once", async () => {
    current = harness();
    const heard: number[] = [];
    const unsubscribe = current.wiring.decisions.onAwayChange(() => heard.push(env.clock));
    await settle(() => heard.length > 0);
    expect(heard).toEqual([env.clock]);
    unsubscribe();
  });

  test("a missed snapshot does not end a prompt; the decision carries on when it is back", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ events: ["blocked"] }));
    const d = decisionRelay(current);
    const raisedAt = env.clock;
    d.raise();
    await settle();
    await d.poll(() => current!.ownerSends.length > 0);
    const code = d.code()!;
    await reachedIm(code);
    // One failed snapshot: the aggregator empties pending and reports disconnected.
    const [held] = current.pending.splice(0);
    current.setWorkerState("disconnected");
    current.emitProjection({ kind: "reset", version: 3, generation: 1, observedAt: env.clock });
    await d.relay.scan();
    expect(promptOf(code)).toMatchObject({ phase: "im" });
    current.pending.push(held!);
    current.setWorkerState("active");
    current.emitProjection({ kind: "reset", version: 4, generation: 1, observedAt: env.clock });
    expect(await d.relay.reply({ message: `回答 ${code} 9`, origin: OWNER_DM })).toContain(
      "请回复选项",
    );
    env.clock = raisedAt + 10 * 60_000;
    await d.relay.scan();
    await settle(() => current!.ownerSends.length > 1);
    expect(d.approvals).toEqual([expect.objectContaining({ failure: "timed_out" })]);
    expect(current.ownerSends[1]!.text).toContain("已超时");
  });

  test("a worker that is really gone revokes its open prompts at once", async () => {
    let live = true;
    current = harness({ hasLiveWorker: () => live });
    await current.handler(SID, upsertArgs({ events: ["blocked"] }));
    const d = decisionRelay(current);
    const raisedAt = env.clock;
    d.raise();
    await settle();
    await d.poll(() => current!.ownerSends.length > 0);
    const code = d.code()!;
    await reachedIm(code);
    current.pending.length = 0;
    live = false;
    current.setWorkerState("disconnected");
    current.emitProjection({ kind: "reset", version: 3, generation: 1, observedAt: env.clock });
    // Even past its deadline: the request died with the worker, it did not time out.
    env.clock = raisedAt + 10 * 60_000;
    await d.relay.scan();
    await settle();
    expect(promptOf(code)).toMatchObject({ phase: "revoked" });
    expect(current.ownerSends).toHaveLength(1);
    expect(d.approvals).toEqual([]);
  });

  test("a prompt whose record keeps failing is retried with backoff, capped at a minute", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ events: ["blocked"] }));
    current.wiring.ledger.record = async () => {
      throw new Error("disk full");
    };
    const timers = fakeTimers();
    const d = decisionRelay(current, timers);
    d.relay.start();
    d.raise();
    await settle();
    let at = env.clock + 15_000;
    const delays: number[] = [];
    for (let index = 0; index < 7; index += 1) {
      timers.advance(at);
      await settle(() => timers.pending().some((due) => due > at));
      const next = timers.pending().find((due) => due > at)!;
      delays.push(next - at);
      at = next;
    }
    expect(delays).toEqual([3_000, 6_000, 12_000, 24_000, 48_000, 60_000, 60_000]);
    d.relay.stop();
  });

  test("the same request on a new connection gets its own record, once, and no retry loop", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ events: ["blocked"] }));
    const timers = fakeTimers();
    const d = decisionRelay(current, timers);
    const raisedAt = env.clock;
    d.raise();
    await settle();
    await d.poll(() => current!.ownerSends.length > 0);
    const oldCode = d.code()!;
    await reachedIm(oldCode);
    // The worker connection changed: the same request is republished with a new code.
    d.raise("req-1", raisedAt, "worker-2");
    const newCode = d.code()!;
    expect(newCode).not.toBe(oldCode);
    d.relay.start();
    await settle(() => promptOf(newCode) !== undefined);
    await d.relay.scan();
    // The resubmission is the policy's duplicate: nothing more reaches the owner.
    expect(current.ownerSends).toHaveLength(1);
    expect(promptOf(oldCode)).toMatchObject({ phase: "im" });
    // It catches up from the first copy, which reached the owner's chat.
    expect(promptOf(newCode)).toMatchObject({ phase: "im", channel: "wechat" });
    // Recorded: the next moment is its deadline, not a 3 s retry.
    expect(timers.pending()).toEqual([raisedAt + 10 * 60_000]);
    d.relay.stop();
  });

  test("a new IM-started task nudges the decisions: its conversation gets the prompt", async () => {
    let changed: (() => void) | undefined;
    const tasks: PetLongTask[] = [];
    current = harness({
      longTasks: {
        activeForSession: (id) => tasks.find((task) => task.sessionId === id),
        getSnapshot: () => ({ tasks }),
        subscribe: (listener) => {
          changed = listener;
          return () => (changed = undefined);
        },
      },
    });
    const nudged: string[] = [];
    current.wiring.decisions.onBlocked((sessionId) => nudged.push(sessionId));
    tasks.push(longTask({ status: "running", completedAt: undefined }));
    changed!();
    expect(nudged).toHaveLength(1);
    current.wiring.dispose();
    expect(changed).toBeUndefined();
  });

  test("a request prompted before the upgrade continues from its record", async () => {
    // What an older build left: the first prompt, sent to the owner's chat, with no lifecycle.
    const before = new PetNoticeLedger({
      path: join(env.dir, "pet", "notices.json"),
      now: () => env.clock,
    });
    const old = await before.record({
      kind: "session.blocked",
      priority: "P0",
      dedupeKey: `${SID}:req-1`,
      sessionId: SID,
      requestId: "req-1",
      ruleIds: [],
      facts: { target: { kind: "owner" } },
      body: "确认 …",
      decision: { outlet: "im", im: "wechat", reason: "away-last-inbound" },
    });
    await before.claim(old.id, "wechat", "确认 …");
    await before.settle(old.id, "accepted");
    await before.flush();
    current = harness();
    await current.wiring.ready;
    await current.handler(SID, upsertArgs({ events: ["blocked"] }));
    const d = decisionRelay(current);
    d.raise();
    env.clock += 16_000;
    await d.relay.scan();
    await settle();
    expect(current.ownerSends).toEqual([]);
    expect(current.wiring.ledger.get(old.id)?.prompt).toMatchObject({
      code: d.code(),
      phase: "im",
      channel: "wechat",
    });
    expect(await d.relay.reply({ message: "1", origin: OWNER_DM })).toContain("已处理");
  });

  test("the prompt's deadline timer denies it and tells the chat it went to", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ events: ["blocked"] }));
    const timers = fakeTimers();
    const d = decisionRelay(current, timers);
    d.relay.start();
    const raisedAt = env.clock;
    d.raise();
    await settle();
    timers.advance(raisedAt + 15_000);
    await settle(() => current!.ownerSends.length > 0);
    await settle(() => timers.pending().includes(raisedAt + 10 * 60_000));
    expect(timers.pending()).toEqual([raisedAt + 10 * 60_000]);
    timers.advance(raisedAt + 10 * 60_000);
    await settle(() => current!.ownerSends.length > 1);
    expect(d.approvals).toEqual([
      expect.objectContaining({ approved: false, failure: "timed_out" }),
    ]);
    expect(current.ownerSends.map((send) => send.targetId)).toEqual([
      "wechat:owner",
      "wechat:owner",
    ]);
    expect(current.ownerSends[1]!.text).toContain("已超时");
    d.relay.stop();
  });

  test("owner present with an auto rule: no IM prompt, only the pet's pending surface", async () => {
    current = harness({
      presence: { getSystemIdleTimeSec: () => 0, hasFocusedWindow: () => true },
    });
    await current.handler(SID, upsertArgs({ events: ["blocked"] }));
    const d = decisionRelay(current);
    d.raise();
    await settle();
    await d.poll();
    expect(current.ownerSends).toEqual([]);
    expect(current.published).toEqual([]);
    expect(current.desktop).toEqual([]);
    current.wiring.router.start();
    expect(current.wiring.attention.getSnapshot().surfaceablePendingCount).toBe(1);
    // A code the owner never received answers nothing, and a bare number is ordinary chat.
    expect(await d.relay.reply({ message: "1", origin: OWNER_DM })).toBeUndefined();
  });

  test("quiet hours never hold a P0 decision prompt", async () => {
    current = harness({
      readSettings: () => ({
        pet: { notifications: { quietHours: { start: "00:00", end: "23:59" } } },
      }),
    });
    await current.handler(SID, upsertArgs({ events: ["blocked"] }));
    const d = decisionRelay(current);
    d.raise();
    await settle();
    await d.poll(() => current!.ownerSends.length > 0);
    expect(current.ownerSends).toHaveLength(1);
    expect(current.ownerSends[0]!.text).toContain("只允许这一次吗？直接回我就行。");
  });

  test("a missed snapshot never makes a queued prompt stale; a live one without it does", async () => {
    current = harness();
    current.channels[1] = { id: "lark", label: "飞书", ready: "unavailable" };
    await current.handler(SID, upsertArgs({ events: ["blocked"], channel: "lark" }));
    const d = decisionRelay(current);
    d.raise();
    await settle();
    await d.poll(() => current!.wiring.ledger.queued().length > 0);
    const [queued] = current.wiring.ledger.queued();
    current.channels[1] = {
      id: "lark",
      label: "飞书",
      ready: "ready",
      targetId: "lark:owner",
      isDirect: true,
    };
    const owner = { channel: "lark", target: "dm-1", isDirectMessage: true };
    // One failed snapshot: pending emptied, no pending-remove for the decision.
    current.pending.length = 0;
    current.setWorkerState("disconnected");
    let replay = current.wiring.inboundReplay(owner)!;
    expect((await replay.take()).map((notice) => notice.kind)).toEqual(["session.blocked"]);
    replay.finish();
    expect(current.wiring.ledger.get(queued!.id)?.delivery?.status).toBe("queued");
    // A live snapshot without the decision: it was resolved.
    current.setWorkerState("active");
    replay = current.wiring.inboundReplay(owner)!;
    expect(await replay.take()).toEqual([]);
    replay.finish();
    expect(current.wiring.ledger.get(queued!.id)?.delivery).toMatchObject({
      status: "revoked",
      error: "resolved",
    });
  });

  test("a resolved decision's queued prompt is revoked and never replayed", async () => {
    current = harness();
    current.channels[1] = { id: "lark", label: "飞书", ready: "unavailable" };
    await current.handler(SID, upsertArgs({ events: ["blocked"], channel: "lark" }));
    const d = decisionRelay(current);
    d.raise();
    await settle();
    await d.poll(() => current!.wiring.ledger.queued().length > 0);
    expect(current.ownerSends).toEqual([]);
    const queued = current.wiring.ledger.queued();
    expect(queued.map((record) => [record.kind, record.requestId])).toEqual([
      ["session.blocked", "req-1"],
    ]);
    // Answered on the desktop.
    current.pending.length = 0;
    current.emitProjection({
      kind: "pending-remove",
      sessionId: SID,
      requestId: "req-1",
      version: 3,
      generation: 1,
      observedAt: env.clock,
    });
    await settle(() => current!.wiring.ledger.queued().length === 0);
    expect(current.wiring.ledger.queued()).toEqual([]);
    expect(current.wiring.ledger.get(queued[0]!.id)?.delivery).toMatchObject({
      status: "revoked",
      error: "resolved",
    });
    // The prompt's own lifecycle ends too (it left the projection unanswered from here).
    await d.relay.scan();
    expect(current.wiring.ledger.get(queued[0]!.id)?.prompt).toMatchObject({ phase: "revoked" });
    current.channels[1] = {
      id: "lark",
      label: "飞书",
      ready: "ready",
      targetId: "lark:owner",
      isDirect: true,
    };
    const replay = current.wiring.inboundReplay({
      channel: "lark",
      target: "dm-1",
      isDirectMessage: true,
    })!;
    expect(await replay.take()).toEqual([]);
    replay.finish();
    expect(current.ownerSends).toEqual([]);
  });
});
