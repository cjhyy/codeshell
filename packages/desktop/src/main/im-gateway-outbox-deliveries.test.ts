import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GatewayControlServer,
  SERVED_EXPIRY_GRACE_MS,
  type DesktopControlDescriptor,
  type GatewayControlEventInput,
  type OutboxDeliveryResult,
} from "./im-gateway-control-server.js";
import { decideOutboxResult, outboxRetryDelayMs } from "./im-gateway-outbox-deliveries.js";

const roots: string[] = [];
const servers: GatewayControlServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

async function outbox(root?: string) {
  const dir = root ?? mkdtempSync(join(tmpdir(), "codeshell-outbox-deliveries-"));
  if (!root) roots.push(dir);
  const clock = { now: 1_000 };
  const server = new GatewayControlServer({
    descriptorPath: join(dir, "desktop-control.json"),
    open: async () => ({
      url: "https://x.test",
      pairingUrl: "https://x.test/p",
      expiresAt: 1,
      mode: "lan",
    }),
    close: async () => undefined,
    status: () => ({
      running: false,
      tunnelRunning: false,
      tunnelConnected: false,
      passcodeSet: true,
      onlineDeviceCount: 0,
    }),
    pairingUrl: async () => ({ pairingUrl: "https://x.test/p", expiresAt: 1 }),
    now: () => clock.now,
  });
  servers.push(server);
  const descriptor = await server.start();
  const streamId = server.eventContext()!.streamId;
  const results: OutboxDeliveryResult[] = [];
  server.onEventResult((result) => results.push(result));
  const request = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const response = await fetch(`${descriptor.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${(descriptor as DesktopControlDescriptor).token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return (await response.json()) as Record<string, unknown>;
  };
  /** One relay poll: the copies it would send and the cursor it would acknowledge. */
  const page = async (after = 0) =>
    (await request("GET", `/v1/events?after=${after}&waitMs=0`)) as {
      events: Array<{ id: number; deliveryKey: string; attempt?: number; text: string }>;
      cursor: number;
    };
  const report = (eventId: number, outcome: string, extra: Record<string, unknown> = {}) =>
    request("POST", "/v1/events/result", { streamId, eventId, outcome, ...extra });
  const live = async (eventId: number) =>
    (await request("POST", "/v1/events/live", { streamId, eventId })).live;
  return { dir, server, clock, results, page, report, live, streamId };
}

const owner = (extra: Partial<GatewayControlEventInput> = {}): GatewayControlEventInput => ({
  deliveryKey: KEY_A,
  type: "pet.task.completed",
  text: "做完了",
  target: { channel: "wechat", target: "owner-dm" },
  maxAttempts: 3,
  ...extra,
});

describe("the retry policy", () => {
  test("budgeted deliveries give up; unbudgeted ones are retried until delivered", () => {
    const failed = { outcome: "failed" as const, attempted: true, idempotent: true };
    expect(decideOutboxResult({ maxAttempts: 2 }, failed, 0)).toEqual({
      kind: "retry",
      dueAt: 2_000,
      attempt: 2,
    });
    expect(decideOutboxResult({ maxAttempts: 2, attempt: 2 }, failed, 0)).toMatchObject({
      kind: "settle",
      outcome: "failed",
    });
    // Possibly delivered on a channel that cannot drop a duplicate: never resent.
    expect(
      decideOutboxResult({ maxAttempts: 5 }, { ...failed, idempotent: false }, 0),
    ).toMatchObject({ kind: "settle", outcome: "unknown" });
    // Unbudgeted (session replies, automations): the at-least-once promise stands.
    expect(decideOutboxResult({ attempt: 30 }, { ...failed, idempotent: false }, 0)).toMatchObject({
      kind: "retry",
      attempt: 31,
    });
    // The next copy would land after the deadline.
    expect(decideOutboxResult({ maxAttempts: 5, expiresAt: 1_500 }, failed, 0)).toMatchObject({
      kind: "settle",
      outcome: "expired",
    });
    expect(outboxRetryDelayMs(10, true)).toBe(60_000);
  });
});

describe("gateway outbox deliveries", () => {
  test("a transient failure is retried as a new copy with the same key, then delivered", async () => {
    const o = await outbox();
    const first = await o.server.publish(owner());
    await o.report(first.id, "failed", { attempted: true, idempotent: true });
    expect(o.server.deliveryState(KEY_A)).toBe("pending");
    // Not served again until its retry is due.
    expect((await o.page(first.id)).events).toEqual([]);
    o.clock.now += 2_000;
    await o.server.runDueDeliveries();
    const retried = await o.page(first.id);
    expect(retried.events).toMatchObject([{ deliveryKey: KEY_A, attempt: 2, text: "做完了" }]);
    await o.report(retried.events[0]!.id, "delivered");
    expect(o.results).toEqual([{ deliveryKey: KEY_A, outcome: "delivered" }]);
    expect(o.server.deliveryState(KEY_A)).toMatchObject({ outcome: "delivered" });
  });

  test("an exhausted delivery is reported failed and never holds up a later one", async () => {
    const o = await outbox();
    const bad = await o.server.publish(owner({ maxAttempts: 1 }));
    const next = await o.server.publish({
      deliveryKey: KEY_B,
      type: "session.reply",
      text: "另一个渠道",
      target: { channel: "telegram", target: "42" },
    });
    // The relay tries each once and reports; both are served in one page.
    expect((await o.page()).events.map((event) => event.id)).toEqual([bad.id, next.id]);
    await o.report(bad.id, "failed", { attempted: true, idempotent: true, error: "no context" });
    expect(o.results).toEqual([{ deliveryKey: KEY_A, outcome: "failed", error: "no context" }]);
    expect(await o.live(bad.id)).toBe(false);
    expect(await o.live(next.id)).toBe(true);
  });

  test("a possibly delivered send on a channel without client ids is unknown, not resent", async () => {
    const o = await outbox();
    const event = await o.server.publish(owner({ target: { channel: "telegram", target: "1" } }));
    await o.report(event.id, "failed", { attempted: true, idempotent: false });
    expect(o.results).toEqual([{ deliveryKey: KEY_A, outcome: "unknown" }]);
    o.clock.now += 60_000;
    await o.server.runDueDeliveries();
    expect((await o.page()).events).toEqual([]);
  });

  test("a revoked delivery is never served, and a copy being sent stops", async () => {
    const o = await outbox();
    const served = await o.server.publish(owner());
    // Revoked between serve and send: the relay's check before the send says no.
    expect((await o.page()).events).toHaveLength(1);
    expect(await o.server.revokeDelivery(KEY_A, "answered")).toBe(true);
    expect(await o.live(served.id)).toBe(false);
    // Revoked before serve: never served. Closed copies at the head are
    // acknowledged by Desktop itself, so they hold neither capacity nor cursor.
    await o.server.publish(owner({ deliveryKey: KEY_B }));
    await o.server.revokeDelivery(KEY_B);
    expect((await o.page()).events).toEqual([]);
    // A pending retry is dropped too.
    const third = await o.server.publish(owner({ deliveryKey: "c".repeat(64) }));
    await o.report(third.id, "failed", { attempted: false });
    await o.server.revokeDelivery("c".repeat(64));
    o.clock.now += 10_000;
    await o.server.runDueDeliveries();
    expect((await o.page()).events).toEqual([]);
    // Nobody is told about a delivery they withdrew themselves.
    expect(o.results).toEqual([]);
    expect(o.server.deliveryState(KEY_A)).toMatchObject({ outcome: "revoked" });
  });

  test("an expired delivery is settled at its deadline and never served", async () => {
    const o = await outbox();
    await o.server.publish(owner({ expiresAt: 5_000 }));
    expect((await o.page()).events).toHaveLength(1);
    o.clock.now = 5_000;
    expect((await o.page()).events).toEqual([]);
    // It was read before the deadline: it may be mid-send, so it waits out the grace.
    await o.server.runDueDeliveries();
    expect(o.results).toEqual([]);
    o.clock.now = 5_000 + SERVED_EXPIRY_GRACE_MS;
    await o.server.runDueDeliveries();
    expect(o.results).toEqual([{ deliveryKey: KEY_A, outcome: "expired" }]);
  });

  test("a copy being sent at its deadline is not expired; a late delivered still counts", async () => {
    const o = await outbox();
    const event = await o.server.publish(owner({ expiresAt: 5_000 }));
    // The relay read it and is sending when the deadline passes.
    expect((await o.page()).events).toHaveLength(1);
    o.clock.now = 5_000;
    await o.server.runDueDeliveries();
    expect(o.results).toEqual([]);
    await o.report(event.id, "delivered");
    expect(o.results).toEqual([{ deliveryKey: KEY_A, outcome: "delivered" }]);

    // Past the grace it does expire; a report after that still settles it delivered.
    const late = await o.server.publish(owner({ deliveryKey: KEY_B, expiresAt: 6_000 }));
    expect(await o.live(late.id)).toBe(true);
    o.clock.now = 6_000 + SERVED_EXPIRY_GRACE_MS;
    await o.server.runDueDeliveries();
    expect(o.results.at(-1)).toEqual({ deliveryKey: KEY_B, outcome: "expired" });
    await o.report(late.id, "delivered", { deliveryKey: KEY_B });
    expect(o.results.at(-1)).toEqual({ deliveryKey: KEY_B, outcome: "delivered" });
    expect(o.server.deliveryState(KEY_B)).toMatchObject({ outcome: "delivered" });
  });

  test("an acknowledged copy without a report is settled unknown (or expired)", async () => {
    const o = await outbox();
    await o.server.publish(owner());
    await o.server.publish(owner({ deliveryKey: KEY_B, expiresAt: 1_500 }));
    o.clock.now = 2_000;
    // A cursor past both, with no result for either.
    await o.page(2);
    expect(o.results).toEqual([
      { deliveryKey: KEY_A, outcome: "unknown" },
      { deliveryKey: KEY_B, outcome: "expired" },
    ]);
  });

  test("a report whose deliveryKey is not the copy's is rejected", async () => {
    const o = await outbox();
    const event = await o.server.publish(owner());
    expect(await o.report(event.id, "delivered", { deliveryKey: KEY_B })).toMatchObject({
      error: "operation_failed",
    });
    expect(o.results).toEqual([]);
  });

  test("a definite rejection is retried within its budget, never settled unknown", async () => {
    const o = await outbox();
    const event = await o.server.publish(owner({ target: { channel: "telegram", target: "1" } }));
    await o.report(event.id, "failed", { attempted: false, idempotent: false });
    expect(o.results).toEqual([]);
    expect(o.server.deliveryState(KEY_A)).toBe("pending");
  });

  test("delivery state is not ready until the outbox has been read", () => {
    const dir = mkdtempSync(join(tmpdir(), "codeshell-outbox-not-ready-"));
    roots.push(dir);
    const server = new GatewayControlServer({
      descriptorPath: join(dir, "desktop-control.json"),
      open: async () => ({ url: "", pairingUrl: "", expiresAt: 1, mode: "lan" }),
      close: async () => undefined,
      status: () => ({
        running: false,
        tunnelRunning: false,
        tunnelConnected: false,
        passcodeSet: true,
        onlineDeviceCount: 0,
      }),
      pairingUrl: async () => ({ pairingUrl: "", expiresAt: 1 }),
    });
    expect(server.deliveryState(KEY_A)).toBe("not-ready");
  });

  test("publishing is idempotent by key; closed heads free their capacity", async () => {
    const o = await outbox();
    const first = await o.server.publish(owner());
    expect((await o.server.publish(owner())).id).toBe(first.id);
    await o.report(first.id, "delivered");
    const state = JSON.parse(readFileSync(join(o.dir, "desktop-control.json.events"), "utf-8"));
    expect(state).toMatchObject({ version: 3, acknowledgedEventId: first.id, events: [] });
  });

  test("retries and settled deliveries survive a restart", async () => {
    const o = await outbox();
    const first = await o.server.publish(owner());
    await o.report(first.id, "failed", { attempted: true, idempotent: true });
    const second = await o.server.publish(owner({ deliveryKey: KEY_B }));
    await o.report(second.id, "delivered");
    await o.server.stop();
    const again = await outbox(o.dir);
    expect(again.server.deliveryState(KEY_A)).toBe("pending");
    expect(again.server.deliveryState(KEY_B)).toMatchObject({ outcome: "delivered" });
    again.clock.now += 2_000;
    await again.server.runDueDeliveries();
    expect((await again.page()).events).toMatchObject([{ deliveryKey: KEY_A, attempt: 2 }]);
  });
});
