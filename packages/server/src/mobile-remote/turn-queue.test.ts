import { describe, expect, test } from "bun:test";
import {
  MAX_TURN_QUEUE_ENTRIES_PER_TARGET,
  MobileTurnQueue,
  turnQueueTargetKey,
  type TurnQueueDispatchResult,
  type TurnQueueEntry,
  type TurnQueueGate,
  type TurnQueueSubmission,
} from "./turn-queue.js";
import type { MobileTurnQueueTarget } from "./types.js";

type Payload = { text: string };
const session: MobileTurnQueueTarget = { kind: "session", sessionId: "s-1" };
const room: MobileTurnQueueTarget = { kind: "room", roomId: "r-1" };

function fixture(options: { settleMs?: number } = {}) {
  let clock = 1_000;
  const busy = new Set<string>();
  const dispatched: string[] = [];
  const published: string[] = [];
  const discarded: string[] = [];
  let gate: (entry: Readonly<TurnQueueEntry<Payload>>) => TurnQueueGate = () => ({ ok: true });
  let next: (entry: Readonly<TurnQueueEntry<Payload>>) => Promise<TurnQueueDispatchResult> = async (
    entry,
  ) => {
    // The real submit paths mark the target busy before acknowledging.
    busy.add(turnQueueTargetKey(entry.target));
    return { ok: true };
  };
  const queue = new MobileTurnQueue<Payload>({
    isBusy: (target) => busy.has(turnQueueTargetKey(target)),
    canDispatch: (entry) => gate(entry),
    dispatch: (entry) => {
      dispatched.push(entry.payload.text);
      return next(entry);
    },
    publish: (target) => published.push(turnQueueTargetKey(target)),
    discard: (entry) => discarded.push(entry.payload.text),
    intervalMs: 0,
    settleMs: options.settleMs ?? 0,
    now: () => clock,
  });
  const submit = (
    text: string,
    extra: Partial<TurnQueueSubmission<Payload>> = {},
  ): ReturnType<typeof queue.enqueue> =>
    queue.enqueue({
      target: session,
      clientMessageId: `cm-${text}`,
      deviceId: "phone",
      viewerId: "viewer-1",
      text,
      attachments: [],
      uploadIds: [],
      payload: { text },
      ...extra,
    });
  return {
    queue,
    busy,
    dispatched,
    published,
    discarded,
    submit,
    idle: (target: MobileTurnQueueTarget = session) => {
      busy.delete(turnQueueTargetKey(target));
    },
    setGate: (value: typeof gate) => {
      gate = value;
    },
    setDispatch: (value: typeof next) => {
      next = value;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const texts = (queue: MobileTurnQueue<Payload>, target = session) =>
  queue.snapshot(target).entries.map((entry) => entry.text);

describe("MobileTurnQueue", () => {
  test("holds turns while busy and runs them FIFO, one per idle boundary", async () => {
    const f = fixture();
    f.busy.add(turnQueueTargetKey(session));
    expect(f.submit("one").kind).toBe("queued");
    expect(f.submit("two").kind).toBe("queued");
    expect(f.submit("three").kind).toBe("queued");
    await f.queue.pumpAll();
    expect(f.dispatched).toEqual([]);
    expect(texts(f.queue)).toEqual(["one", "two", "three"]);

    f.idle();
    await f.queue.pumpAll();
    // The first dispatch made the target busy again; the rest must wait.
    expect(f.dispatched).toEqual(["one"]);
    await f.queue.pumpAll();
    expect(f.dispatched).toEqual(["one"]);
    f.idle();
    await f.queue.pumpAll();
    f.idle();
    await f.queue.pumpAll();
    expect(f.dispatched).toEqual(["one", "two", "three"]);
    expect(f.queue.has(session)).toBe(false);
  });

  test("an idle target runs the first submission immediately", async () => {
    const f = fixture();
    const result = f.submit("now");
    expect(result.kind).toBe("queued");
    const pumping = f.queue.pump(session);
    if (result.kind !== "queued") throw new Error("unreachable");
    expect(result.entry.status).toBe("dispatching");
    await pumping;
    expect(f.dispatched).toEqual(["now"]);
  });

  test("targets are independent: a busy session never blocks a room", async () => {
    const f = fixture();
    f.busy.add(turnQueueTargetKey(session));
    f.submit("session turn");
    f.submit("room turn", { target: room, clientMessageId: "cm-room" });
    await f.queue.pumpAll();
    expect(f.dispatched).toEqual(["room turn"]);
    expect(texts(f.queue)).toEqual(["session turn"]);
  });

  test("cancel removes only that pending turn and releases its uploads", async () => {
    const f = fixture();
    f.busy.add(turnQueueTargetKey(session));
    f.submit("keep-1");
    const drop = f.submit("drop");
    f.submit("keep-2");
    if (drop.kind !== "queued") throw new Error("unreachable");
    expect(f.queue.cancel(session, drop.entry.id)).toEqual({ ok: true });
    expect(texts(f.queue)).toEqual(["keep-1", "keep-2"]);
    expect(f.discarded).toEqual(["drop"]);
    // A replay of the cancelled intent is not admitted again.
    expect(f.submit("drop")).toEqual({ kind: "settled", outcome: "cancelled" });
    f.idle();
    await f.queue.pumpAll();
    f.idle();
    await f.queue.pumpAll();
    expect(f.dispatched).toEqual(["keep-1", "keep-2"]);
  });

  test("an entry being submitted cannot be cancelled or cleared", async () => {
    const f = fixture();
    let release!: (result: TurnQueueDispatchResult) => void;
    f.setDispatch(() => new Promise((resolve) => (release = resolve)));
    const first = f.submit("in flight");
    f.submit("pending");
    if (first.kind !== "queued") throw new Error("unreachable");
    const pumping = f.queue.pump(session);
    expect(f.queue.cancel(session, first.entry.id).ok).toBe(false);
    expect(f.queue.clear(session)).toBe(1);
    expect(texts(f.queue)).toEqual(["in flight"]);
    release({ ok: true });
    await pumping;
    expect(f.queue.has(session)).toBe(false);
    expect(f.discarded).toEqual(["pending"]);
  });

  test("Stop pauses pending turns without dropping them; resume continues FIFO", async () => {
    const f = fixture();
    f.busy.add(turnQueueTargetKey(session));
    f.submit("a");
    f.submit("b");
    f.queue.pause(session, "stopped");
    f.idle();
    await f.queue.pumpAll();
    expect(f.dispatched).toEqual([]);
    expect(f.queue.snapshot(session).paused).toBe("stopped");
    expect(texts(f.queue)).toEqual(["a", "b"]);
    expect(f.queue.resume(session)).toEqual({ ok: true });
    await f.queue.pumpAll();
    expect(f.dispatched).toEqual(["a"]);
  });

  test("a rejected head pauses later turns and can be retried with the same intent", async () => {
    const f = fixture();
    f.busy.add(turnQueueTargetKey(session));
    f.submit("bad");
    f.submit("later");
    f.setDispatch(async () => ({ ok: false, message: "rejected by host" }));
    f.idle();
    await f.queue.pumpAll();
    const state = f.queue.snapshot(session);
    expect(state.paused).toBe("failed");
    expect(state.entries[0]).toMatchObject({ status: "failed", message: "rejected by host" });
    await f.queue.pumpAll();
    expect(f.dispatched).toEqual(["bad"]);

    f.setDispatch(async (entry) => {
      f.busy.add(turnQueueTargetKey(entry.target));
      return { ok: true };
    });
    expect(f.queue.retry(session, state.entries[0]!.id)).toEqual({ ok: true });
    await f.queue.pumpAll();
    expect(f.dispatched).toEqual(["bad", "bad"]);
    expect(f.queue.snapshot(session).paused).toBeUndefined();
  });

  test("removing a failed head resumes the next turn", async () => {
    const f = fixture();
    f.setDispatch(async () => ({ ok: false, message: "no worker" }));
    f.submit("fails", { transient: false });
    f.submit("next");
    await f.queue.pumpAll();
    const head = f.queue.snapshot(session).entries[0]!;
    f.setDispatch(async () => ({ ok: true }));
    f.queue.cancel(session, head.id);
    await f.queue.pumpAll();
    expect(f.dispatched).toEqual(["fails", "next"]);
  });

  test("an uncertain head is never retried automatically", async () => {
    const f = fixture();
    f.setDispatch(async () => ({ ok: false, uncertain: true, message: "no acknowledgement" }));
    f.submit("maybe");
    f.submit("after");
    await f.queue.pumpAll();
    const state = f.queue.snapshot(session);
    expect(state.paused).toBe("uncertain");
    expect(f.queue.retry(session, state.entries[0]!.id).ok).toBe(false);
    expect(f.queue.resume(session).ok).toBe(false);
    await f.queue.pumpAll();
    expect(f.dispatched).toEqual(["maybe"]);
  });

  test("a direct submission rejected on an idle target is dropped, not parked", async () => {
    const f = fixture();
    f.setDispatch(async () => ({ ok: false, message: "invalid model" }));
    const result = f.submit("direct", { transient: true });
    if (result.kind !== "queued") throw new Error("unreachable");
    // Hidden while its submitter still awaits the original acknowledgement.
    expect(f.queue.snapshot(session).entries).toEqual([]);
    await f.queue.pump(session);
    expect(f.queue.has(session)).toBe(false);
    expect(f.queue.snapshot(session).paused).toBeUndefined();
    // The same intent may be retried as a fresh submission.
    expect(f.submit("direct").kind).toBe("queued");
  });

  test("reveal publishes a deferred direct submission", () => {
    const f = fixture();
    f.busy.add(turnQueueTargetKey(session));
    const result = f.submit("deferred", { transient: true });
    if (result.kind !== "queued") throw new Error("unreachable");
    expect(f.queue.snapshot(session).entries).toEqual([]);
    f.queue.reveal(session, result.entry.id);
    expect(texts(f.queue)).toEqual(["deferred"]);
  });

  test("replays are deduplicated by device and intent across reconnects", async () => {
    const f = fixture();
    f.busy.add(turnQueueTargetKey(session));
    const first = f.submit("once");
    const replay = f.submit("once", { viewerId: "viewer-after-reconnect" });
    expect(first.kind).toBe("queued");
    expect(replay.kind).toBe("duplicate");
    expect(texts(f.queue)).toEqual(["once"]);
    // Another device may legitimately reuse an id; it is not the same intent.
    expect(f.submit("once", { deviceId: "tablet" }).kind).toBe("queued");
    f.idle();
    await f.queue.pumpAll();
    expect(f.submit("once")).toEqual({ kind: "settled", outcome: "dispatched" });
  });

  test("an unavailable owner waits instead of failing, then a same-device tab continues", async () => {
    const f = fixture();
    f.busy.add(turnQueueTargetKey(session));
    f.submit("owned");
    f.setGate(() => ({ ok: false, message: "owner away" }));
    f.idle();
    await f.queue.pumpAll();
    expect(f.queue.snapshot(session).entries[0]).toMatchObject({
      status: "waiting",
      message: "owner away",
    });
    expect(f.dispatched).toEqual([]);
    let ranAs: string | undefined;
    f.setGate(() => ({ ok: true, viewerId: "viewer-2" }));
    f.setDispatch(async (entry) => {
      ranAs = entry.viewerId;
      return { ok: true };
    });
    await f.queue.pumpAll();
    expect(f.dispatched).toEqual(["owned"]);
    expect(ranAs).toBe("viewer-2");
  });

  test("snapshots mark only the recipient's own entries and keep monotonic revisions", () => {
    const f = fixture();
    f.busy.add(turnQueueTargetKey(session));
    f.submit("mine", {
      permissionMode: "acceptEdits",
      modelKey: "codex/gpt",
      attachments: [{ clientId: "c", name: "a.png", mime: "image/png", size: 3 }],
    });
    f.submit("theirs", { deviceId: "tablet", clientMessageId: "cm-tablet" });
    const phone = f.queue.snapshot(session, "phone");
    const tablet = f.queue.snapshot(session, "tablet");
    expect(phone.entries.map((entry) => entry.ownDevice)).toEqual([true, false]);
    expect(tablet.entries.map((entry) => entry.ownDevice)).toEqual([false, true]);
    expect(phone.entries[0]).toMatchObject({
      permissionMode: "acceptEdits",
      modelKey: "codex/gpt",
      attachments: [{ name: "a.png", size: 3 }],
    });
    expect(phone.epoch).toBe(f.queue.epoch);
    const before = phone.revision;
    f.queue.clear(session);
    const cleared = f.queue.snapshot(session, "phone");
    expect(cleared.entries).toEqual([]);
    expect(cleared.revision).toBeGreaterThan(before);
    f.submit("again", { clientMessageId: "cm-new" });
    expect(f.queue.snapshot(session).revision).toBeGreaterThan(cleared.revision);
    expect(f.published.length).toBeGreaterThan(0);
  });

  test("bounds each conversation and rejects empty submissions", () => {
    const f = fixture();
    f.busy.add(turnQueueTargetKey(session));
    for (let index = 0; index < MAX_TURN_QUEUE_ENTRIES_PER_TARGET; index++)
      expect(f.submit(`m${index}`).kind).toBe("queued");
    expect(f.submit("overflow").kind).toBe("rejected");
    expect(f.submit("", { target: room, clientMessageId: "empty" }).kind).toBe("rejected");
  });

  test("a device that cannot run now does not hold back other devices; its own order holds", async () => {
    const f = fixture();
    f.busy.add(turnQueueTargetKey(session));
    f.submit("phone-1", { deviceId: "phone" });
    f.submit("phone-2", { deviceId: "phone", clientMessageId: "cm-phone-2" });
    f.submit("tablet-1", { deviceId: "tablet", clientMessageId: "cm-tablet-1" });
    f.setGate((entry) =>
      entry.deviceId === "phone" ? { ok: false, message: "phone away" } : { ok: true },
    );
    f.idle();
    await f.queue.pumpAll();
    expect(f.dispatched).toEqual(["tablet-1"]);
    expect(f.queue.snapshot(session).entries.map((entry) => entry.status)).toEqual([
      "waiting",
      "queued",
    ]);
    f.setGate(() => ({ ok: true }));
    f.idle();
    await f.queue.pumpAll();
    f.idle();
    await f.queue.pumpAll();
    expect(f.dispatched).toEqual(["tablet-1", "phone-1", "phone-2"]);
  });

  test("a possibly admitted direct submission stays visible, deduplicates and never reruns", async () => {
    const f = fixture();
    f.setDispatch(async () => ({ ok: false, uncertain: true, message: "persist failed" }));
    const first = f.submit("maybe-ran", { transient: true, fingerprint: "a" });
    if (first.kind !== "queued") throw new Error("unreachable");
    await f.queue.pump(session);
    const state = f.queue.snapshot(session);
    expect(state.entries.map((entry) => entry.status)).toEqual(["uncertain"]);
    expect(state.paused).toBe("uncertain");
    // The same intent replayed (e.g. after reconnect) is the same turn.
    expect(f.queue.lookup(session, "phone", "cm-maybe-ran", "a")?.kind).toBe("duplicate");
    expect(f.submit("maybe-ran", { fingerprint: "a" }).kind).toBe("duplicate");
    expect(f.queue.retry(session, first.entry.id).ok).toBe(false);
    expect(f.queue.resume(session).ok).toBe(false);
    await f.queue.pumpAll();
    expect(f.dispatched).toEqual(["maybe-ran"]);
  });

  test("a receipt is found before admission and a reused id with other content is refused", async () => {
    const f = fixture();
    f.submit("once", { fingerprint: "content-1" });
    await f.queue.pumpAll();
    expect(f.queue.lookup(session, "phone", "cm-once", "content-1")).toEqual({
      kind: "settled",
      outcome: "dispatched",
    });
    expect(f.queue.lookup(session, "phone", "cm-once", "content-2")?.kind).toBe("conflict");
    expect(f.submit("once", { fingerprint: "content-2" }).kind).toBe("rejected");
    // Another target or device never sees this receipt.
    expect(f.queue.lookup(room, "phone", "cm-once", "content-1")).toBeUndefined();
    expect(f.queue.lookup(session, "tablet", "cm-once", "content-1")).toBeUndefined();
    expect(f.dispatched).toEqual(["once"]);
  });

  test("a failure behind a waiting device pauses everything until it is resolved", async () => {
    const f = fixture();
    f.busy.add(turnQueueTargetKey(session));
    f.submit("phone-1", { deviceId: "phone" });
    f.submit("tablet-1", { deviceId: "tablet", clientMessageId: "cm-tablet-1" });
    f.submit("tablet-2", { deviceId: "tablet", clientMessageId: "cm-tablet-2" });
    f.setGate((entry) =>
      entry.deviceId === "phone" ? { ok: false, message: "phone away" } : { ok: true },
    );
    f.setDispatch(async () => ({ ok: false, message: "rejected" }));
    f.idle();
    await f.queue.pumpAll();
    expect(f.queue.snapshot(session).paused).toBe("failed");
    f.setGate(() => ({ ok: true }));
    await f.queue.pumpAll();
    expect(f.dispatched).toEqual(["tablet-1"]);
    const failed = f.queue.snapshot(session).entries.find((entry) => entry.status === "failed")!;
    f.setDispatch(async () => ({ ok: true }));
    f.queue.cancel(session, failed.id);
    await f.queue.pumpAll();
    expect(f.dispatched).toEqual(["tablet-1", "phone-1"]);
  });

  test("a Stop outranks a failure/uncertain pause; fixing the head never restarts the tail", async () => {
    for (const outcome of ["failed", "uncertain"] as const) {
      const f = fixture();
      f.busy.add(turnQueueTargetKey(session));
      f.submit("head");
      f.submit("tail");
      f.setDispatch(async () =>
        outcome === "failed"
          ? { ok: false, message: "rejected" }
          : { ok: false, uncertain: true, message: "maybe ran" },
      );
      f.idle();
      await f.queue.pumpAll();
      expect(f.queue.snapshot(session).paused).toBe(outcome);
      // Desktop (or any device) stops the conversation.
      const before = f.queue.stopGeneration(session);
      f.queue.pause(session, "stopped");
      expect(f.queue.stopGeneration(session)).toBe(before + 1);
      expect(f.queue.snapshot(session).paused).toBe("stopped");
      f.setDispatch(async () => ({ ok: true }));
      const head = f.queue.snapshot(session).entries[0]!;
      if (outcome === "failed") expect(f.queue.retry(session, head.id)).toEqual({ ok: true });
      else expect(f.queue.retry(session, head.id).ok).toBe(false);
      f.queue.cancel(session, head.id);
      await f.queue.pumpAll();
      expect(f.dispatched).toEqual(["head"]);
      expect(f.queue.snapshot(session).paused).toBe("stopped");
      expect(f.queue.resume(session)).toEqual({ ok: true });
      await f.queue.pumpAll();
      expect(f.dispatched).toEqual(["head", "tail"]);
    }
  });

  for (const uncertain of [false, true])
    test(`Stop remains paused when an in-flight ${uncertain ? "uncertain" : "failed"} dispatch settles`, async () => {
      const f = fixture();
      f.busy.add(turnQueueTargetKey(session));
      f.submit("head");
      f.submit("tail");
      let release!: (result: TurnQueueDispatchResult) => void;
      let dispatching!: () => void;
      const ready = new Promise<void>((resolve) => {
        dispatching = resolve;
      });
      f.setDispatch(
        () =>
          new Promise<TurnQueueDispatchResult>((resolve) => {
            release = resolve;
            dispatching();
          }),
      );
      f.idle();
      const pumping = f.queue.pumpAll();
      await ready;
      f.queue.pause(session, "stopped");
      release({ ok: false, uncertain, message: "authority lookup failed after Stop" });
      await pumping;
      expect(f.queue.snapshot(session).paused).toBe("stopped");
      const head = f.queue.snapshot(session).entries[0]!;
      expect(head.status).toBe(uncertain ? "uncertain" : "failed");
      f.queue.cancel(session, head.id);
      f.setDispatch(async () => ({ ok: true }));
      await f.queue.pumpAll();
      expect(f.dispatched).toEqual(["head"]);
      expect(f.queue.snapshot(session).paused).toBe("stopped");
      expect(f.queue.resume(session)).toEqual({ ok: true });
      await f.queue.pumpAll();
      expect(f.dispatched).toEqual(["head", "tail"]);
    });

  test("a dispatch fenced off by Stop returns unchanged to the stopped queue", async () => {
    const f = fixture();
    f.setDispatch(async () => {
      // Stop lands while the turn is being prepared, before any physical input.
      f.queue.pause(session, "stopped");
      return { ok: false, requeue: true, message: "stopped before input" };
    });
    f.submit("fenced");
    await f.queue.pumpAll();
    const state = f.queue.snapshot(session);
    expect(state.paused).toBe("stopped");
    expect(state.entries.map((entry) => [entry.status, entry.message])).toEqual([
      ["queued", undefined],
    ]);
    expect(f.queue.lookup(session, "phone", "cm-fenced")?.kind).toBe("duplicate");
  });

  test("waits the settle interval after an accepted turn before the next head", async () => {
    const f = fixture({ settleMs: 500 });
    f.setDispatch(async () => ({ ok: true }));
    f.submit("first");
    f.submit("second");
    await f.queue.pumpAll();
    await f.queue.pumpAll();
    expect(f.dispatched).toEqual(["first"]);
    f.advance(600);
    await f.queue.pumpAll();
    expect(f.dispatched).toEqual(["first", "second"]);
  });
});
