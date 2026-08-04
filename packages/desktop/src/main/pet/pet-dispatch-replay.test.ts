// A replayed pet turn must not re-run its host actions.
//
// Engine replays the persisted run_result when the same clientMessageId is
// submitted again — the model does not re-run, but the dispatcher used to re-read
// `extensions.pet.hostActions` from that replayed result and execute every
// executor a second time. Observable effect: a duplicate delivery created a
// repeated follow-up mutation or a second proactive message.
//
// These drive the real PetDispatchService with a worker stub that returns the
// SAME result for a repeated clientMessageId, exactly as Engine's replay does.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PetDispatchService } from "./pet-dispatch-service.js";
import { PetHostActionReceiptStore } from "./pet-host-action-receipts.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pet-replay-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Minimal but COMPLETE projection snapshot — boundedWorld() reads `pending`
// too, so an under-specified stub throws before the code under test runs.
const snapshot = {
  version: 4,
  generation: 2,
  workerState: "active",
  observedAt: 10,
  sessions: [],
  pending: [],
} as never;

/**
 * Build a service whose worker always reports one `outboundMessage` host action, as if
 * Mimi had requested it — and whose result is identical across calls, which is
 * what a transcript replay looks like from here.
 */
function makeService(options: {
  receipts?: PetHostActionReceiptStore;
  onSideEffect: () => void;
}): PetDispatchService {
  return new PetDispatchService({
    metadata: { ensure: async () => ({ petSessionId: "pet-one" }) },
    aggregator: {
      getSnapshot: () => snapshot,
      resolveNavigation: async () => ({ status: "not-found" }),
    },
    worker: {
      requestWorker: async () => ({
        ok: true as const,
        result: {
          text: "done",
          extensions: {
            pet: {
              hostActions: [
                { kind: "outboundMessage", payload: { targetId: "owner-1", text: "hi" } },
              ],
            },
          },
        },
      }),
    },
    hostCwd: "/safe/pet",
    hostActions: {
      outboundMessage: async () => {
        options.onSideEffect();
        return { saved: true };
      },
    },
    ...(options.receipts ? { hostActionReceipts: options.receipts } : {}),
  } as never);
}

describe("pet host action replay", () => {
  test("the same clientMessageId executes the host action only once", async () => {
    let calls = 0;
    const receipts = new PetHostActionReceiptStore(join(dir, "receipts.json"));
    const service = makeService({ receipts, onSideEffect: () => (calls += 1) });

    const first = (await service.dispatch({
      type: "chat",
      message: "remember this",
      clientMessageId: "gw:msg-1",
    } as never)) as { ok: boolean; hostActions?: Array<{ ok: boolean }> };
    expect(first.ok).toBe(true);
    expect(first.hostActions?.[0]?.ok).toBe(true);
    expect(calls).toBe(1);

    // Same submission intent again — Engine would replay, so this must not
    // re-run the side effect.
    const second = (await service.dispatch({
      type: "chat",
      message: "remember this",
      clientMessageId: "gw:msg-1",
    } as never)) as { ok: boolean; hostActions?: Array<{ ok: boolean }> };
    expect(second.ok).toBe(true);
    // The reported outcome is still success — replayed from the receipt.
    expect(second.hostActions?.[0]?.ok).toBe(true);
    expect(calls).toBe(1);
  });

  test("receipts survive a restart of the dispatcher", async () => {
    // The realistic duplicate arrives after a process restart, which is why an
    // in-memory guard would not have been enough.
    let calls = 0;
    const path = join(dir, "receipts.json");

    const before = makeService({
      receipts: new PetHostActionReceiptStore(path),
      onSideEffect: () => (calls += 1),
    });
    await before.dispatch({
      type: "chat",
      message: "hi",
      clientMessageId: "gw:msg-2",
    } as never);
    expect(calls).toBe(1);

    // Fresh service + fresh store instance, same file.
    const after = makeService({
      receipts: new PetHostActionReceiptStore(path),
      onSideEffect: () => (calls += 1),
    });
    await after.dispatch({
      type: "chat",
      message: "hi",
      clientMessageId: "gw:msg-2",
    } as never);
    expect(calls).toBe(1);
  });

  test("a stranded pre-execution claim is reported but never repeated", async () => {
    let calls = 0;
    const receipts = new PetHostActionReceiptStore(join(dir, "receipts.json"));
    await receipts.claim("pet-one", "gw:uncertain", 0, "outboundMessage", 1);
    const service = makeService({ receipts, onSideEffect: () => (calls += 1) });

    const replay = (await service.dispatch({
      type: "chat",
      message: "hi",
      clientMessageId: "gw:uncertain",
    } as never)) as {
      hostActions?: Array<{ ok: boolean; error?: string }>;
    };

    expect(calls).toBe(0);
    expect(replay.hostActions?.[0]).toMatchObject({ ok: false });
    expect(replay.hostActions?.[0]?.error).toContain("为避免重复执行");
  });

  test("a different clientMessageId is a new turn and does execute", async () => {
    let calls = 0;
    const receipts = new PetHostActionReceiptStore(join(dir, "receipts.json"));
    const service = makeService({ receipts, onSideEffect: () => (calls += 1) });

    await service.dispatch({ type: "chat", message: "a", clientMessageId: "gw:a" } as never);
    await service.dispatch({ type: "chat", message: "b", clientMessageId: "gw:b" } as never);
    expect(calls).toBe(2);
  });

  test("without a receipt store the old at-least-once behaviour is unchanged", async () => {
    // The option is opt-in; hosts that do not wire it keep working as before.
    let calls = 0;
    const service = makeService({ onSideEffect: () => (calls += 1) });
    await service.dispatch({ type: "chat", message: "x", clientMessageId: "gw:x" } as never);
    await service.dispatch({ type: "chat", message: "x", clientMessageId: "gw:x" } as never);
    expect(calls).toBe(2);
  });
});
