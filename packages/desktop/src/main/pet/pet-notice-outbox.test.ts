import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { GatewayControlEventInput } from "../im-gateway-control-server.js";
import { NOTICE_RESEND_WINDOW_MS } from "./pet-notice-ledger.js";
import type { NoticeSubmission } from "./pet-notice-router.js";
import type { NoticeOutboxState } from "./pet-notice-types.js";
import {
  NOW,
  OWNER_DM,
  SID,
  cleanupNoticeEnv,
  decisionRelay,
  env,
  harness,
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

function done(extra: Partial<NoticeSubmission> = {}): NoticeSubmission {
  return {
    kind: "session.done",
    priority: "P1",
    dedupeKey: `done:${env.clock}`,
    sessionId: SID,
    ruleIds: [],
    facts: { title: "修登录" },
    attention: "always",
    channel: "wechat",
    target: { kind: "owner" },
    ...extra,
  };
}

const status = (h: Harness, dedupeKey: string) =>
  h.wiring.ledger.byDedupeKey(dedupeKey)?.delivery?.status;

describe("owner notices through the gateway outbox", () => {
  test("an owner notice is enqueued, not queued, while the outbox retries it", async () => {
    current = harness();
    current.outbox.hold = true;
    await current.wiring.router.submit(done({ dedupeKey: "done:a", channel: "auto" }));
    const [event] = current.outbox.events;
    // Addressed like a route event: the owner's raw destination, with a budget.
    expect(event).toMatchObject({
      type: "pet.task.completed",
      target: { channel: "wechat", target: "owner-dm" },
      maxAttempts: 5,
    });
    expect(status(current, "done:a")).toBe("enqueued");
    // The router's queue is only for an unavailable channel; the outbox owns the retry.
    expect(current.wiring.ledger.queued()).toEqual([]);
    expect(await current.wiring.inboundReplay(OWNER_DM)!.take()).toEqual([]);
    current.outbox.settle(event!.deliveryKey!, "delivered");
    await current.idle();
    expect(status(current, "done:a")).toBe("accepted");
    expect(current.desktop).toEqual([]);
  });

  test("a delivery the outbox gave up on is shown and waits for the owner's next message", async () => {
    current = harness();
    current.outbox.outcome = () => "failed";
    await current.wiring.router.submit(done({ dedupeKey: "done:b" }));
    await current.idle();
    expect(status(current, "done:b")).toBe("queued");
    expect(current.desktop.map((input) => input.body)).toEqual(["「修登录」做完了"]);
    const replay = current.wiring.inboundReplay(OWNER_DM)!;
    expect(await replay.take()).toMatchObject([{ kind: "session.done", title: "修登录" }]);
    replay.finish();
  });

  test("possibly delivered on a channel without client ids: unknown, never resent", async () => {
    current = harness({ readSettings: () => ({ pet: { notifications: { quietHours: null } } }) });
    current.outbox.outcome = () => "unknown";
    await current.wiring.router.submit(done({ dedupeKey: "done:u", channel: "lark" }));
    await current.idle();
    expect(status(current, "done:u")).toBe("unknown");
    // Named channel: the desktop already showed it.
    expect(current.desktop).toHaveLength(1);
    expect(current.outbox.events).toHaveLength(1);
  });

  test("an owner P1 never lands in quiet hours on a retry: it expires into the digest", async () => {
    current = harness();
    // 22:30 at UTC+0; quiet hours (23:00–08:30) start in half an hour.
    env.clock = Date.UTC(2026, 10, 9, 22, 30, 0);
    current.outbox.hold = true;
    await current.wiring.router.submit(done({ dedupeKey: "done:q" }));
    const [event] = current.outbox.events;
    expect(event!.expiresAt).toBe(Date.UTC(2026, 10, 9, 23, 0, 0));
    env.clock = Date.UTC(2026, 10, 9, 23, 0, 0);
    current.outbox.settle(event!.deliveryKey!, "expired");
    await current.idle();
    expect(status(current, "done:q")).toBe("held");
    current.outbox.hold = false;
    env.clock = Date.UTC(2026, 10, 10, 8, 30, 0);
    await current.wiring.router.flushDigest();
    await current.idle();
    expect(current.ownerSends.map((send) => send.text)).toEqual([
      "「修登录」做完了",
      "你不在时：\n- 「修登录」做完了",
    ]);
  });

  test("a target without a stored WeChat context gets one tokenless try", async () => {
    current = harness();
    current.tokenlessTargets.add("wechat:owner");
    current.outbox.outcome = () => "failed";
    await current.wiring.router.submit(done({ dedupeKey: "done:t" }));
    await current.idle();
    expect(current.outbox.events).toMatchObject([{ maxAttempts: 1 }]);
    // As before: it waits for the owner's next WeChat message (which brings a context).
    expect(status(current, "done:t")).toBe("queued");
  });

  test("a revoked decision prompt is withdrawn from the outbox and never delivered", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ events: ["blocked"] }));
    current.outbox.hold = true;
    const d = decisionRelay(current);
    d.raise();
    await settle();
    await d.poll(() => current!.outbox.events.length > 0);
    const [prompt] = current.outbox.events;
    expect(prompt!.text).toContain(`回答 ${d.code()} 1`);
    // Answered on the desktop before the relay sent it.
    current.pending.length = 0;
    current.emitProjection({
      kind: "pending-remove",
      sessionId: SID,
      requestId: "req-1",
      version: 3,
      generation: 1,
      observedAt: env.clock,
    });
    await settle(() => current!.outbox.revoked.length > 0);
    expect(current.outbox.revoked).toEqual([prompt!.deliveryKey]);
    expect(current.outbox.state(prompt!.deliveryKey!)).toEqual({ outcome: "revoked" });
    const record = current.wiring.ledger.prompts()[0]!;
    expect(record.delivery?.status).toBe("revoked");
  });

  test("a prompt whose decision ended is withdrawn even without a projection event", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ events: ["blocked"] }));
    current.outbox.hold = true;
    const d = decisionRelay(current);
    d.raise();
    await settle();
    await d.poll(() => current!.outbox.events.length > 0);
    // The deadline passed: the prompt's lifecycle ends, and so must its outbox copy.
    env.clock += 10 * 60_000;
    await d.relay.scan();
    await settle(() => current!.outbox.revoked.length > 0);
    expect(new Set(current.outbox.revoked)).toEqual(
      new Set([current.outbox.events[0]!.deliveryKey]),
    );
  });
});

describe("restart with the outbox as the only resender", () => {
  /** A second run on the same files, reading the first run's outbox. */
  function restartOn(
    states: (key: string) => NoticeOutboxState | undefined,
    written = new Set<string>(),
  ) {
    const publishes: GatewayControlEventInput[] = [];
    const h = harness({
      outbox: {
        publish: async (event) => {
          publishes.push(event);
          written.add(event.deliveryKey!);
        },
        revoke: async () => undefined,
        state: states,
      },
    });
    return { h, publishes };
  }

  test("an enqueued notice still in the outbox is not sent again; a settled one is applied", async () => {
    const first = harness();
    first.outbox.hold = true;
    await first.wiring.router.submit(done({ dedupeKey: "done:r1" }));
    await first.wiring.router.submit(done({ dedupeKey: "done:r2", sessionId: "s-2" }));
    const [one, two] = first.outbox.events;
    await first.wiring.flush();
    first.wiring.dispose();

    const { h, publishes } = restartOn((key) =>
      key === one!.deliveryKey ? "pending" : { outcome: "delivered" },
    );
    current = h;
    await h.wiring.ready;
    await h.wiring.router.recover();
    expect(publishes).toEqual([]);
    expect(status(h, "done:r1")).toBe("enqueued");
    expect(status(h, "done:r2")).toBe("accepted");
    expect(two).toBeDefined();
  });

  test("a claim that crashed before reaching the outbox is written once; one that did is not", async () => {
    const first = harness();
    // Two young claims, as a crash mid-publish leaves them.
    const ledger = first.wiring.ledger;
    await ledger.load();
    for (const key of ["done:c1", "done:c2"]) {
      const record = await ledger.record({
        kind: "session.done",
        priority: "P1",
        dedupeKey: key,
        ruleIds: [],
        facts: { title: key, target: { kind: "owner" } },
        body: key,
        decision: { outlet: "im", im: "wechat", reason: "named-channel" },
      });
      await ledger.claim(record.id, "wechat", key);
    }
    await ledger.flush();
    first.wiring.dispose();
    env.clock = NOW + NOTICE_RESEND_WINDOW_MS / 2;
    // The outbox has the first claim it is asked about; the other never got there.
    let had: string | undefined;
    const written = new Set<string>();
    const { h, publishes } = restartOn((key) => {
      had ??= key;
      return key === had || written.has(key) ? "pending" : undefined;
    }, written);
    current = h;
    await h.wiring.ready;
    await h.wiring.router.recover();
    // The one the outbox already had is just tracked; the other is written now.
    expect(publishes).toHaveLength(1);
    expect(
      [status(h, "done:c1"), status(h, "done:c2")].sort((a, b) => String(a).localeCompare(b!)),
    ).toEqual(["enqueued", "enqueued"]);
  });
});
