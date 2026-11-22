import { expect, test } from "bun:test";
import { parseWorkerLine } from "../../main/worker-line.js";
import { HostedMimiProjection } from "./mimi-projection.js";
import { NativeMimiProjection } from "../../main/desktop-host/mimi-projection-client.js";
import type { CallShellBusiness } from "../../shared/shell-business-contracts.js";
import type { DesktopPetSession } from "../../main/pet/pet-state-aggregator.js";
import type { MimiProjectionBaseline } from "../../shared/mimi-projection.js";

const row = (agentSessionId: string) =>
  ({ agentSessionId, external: { cli: "codex" } }) as DesktopPetSession;

test("a replacement owns its external source, clears removed scope and ignores a retired worker read", async () => {
  const started = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<DesktopPetSession[]>();
  const replies = [
    async () => [row("first")],
    () => {
      started.resolve();
      return pending.promise;
    },
    async () => [row("replacement")],
    async () => {
      throw Error("history unavailable");
    },
  ];
  const create = () =>
    new HostedMimiProjection({
      catalog: async () => ({ sessions: [], projects: [], nextCursor: null }),
      memory: async () => ({ epoch: "e", revision: 0, segments: [] }),
      worker: () => undefined,
      external: () => replies.shift()!(),
      report: () => {},
      publish: () => {},
    });
  const first = create();
  const next = create();
  try {
    await first.methods["mimi/projectionSources"]({ projectCwds: [] });
    expect((await first.snapshot()).sessions.map((r) => r.agentSessionId)).toEqual(["first"]);
    first.activityChanged();
    await started.promise;
    const closing = first.close();
    await next.methods["mimi/projectionSources"]({ projectCwds: [] });
    pending.resolve([row("retired")]);
    await closing;
    expect((await next.snapshot()).sessions.map((r) => r.agentSessionId)).toEqual(["replacement"]);
    await expect(next.methods["mimi/projectionSources"]({ projectCwds: [] })).rejects.toThrow(
      "history unavailable",
    );
    expect((await next.snapshot()).sessions).toEqual([]);
  } finally {
    pending.resolve([]);
    await Promise.all([first.close(), next.close()]);
  }
});

test("native observations arriving before their baseline trigger a fresh read; a retired reply cannot restore revoked state", async () => {
  const baseline = (sequence: number, id: string): MimiProjectionBaseline => ({
    sequence,
    snapshot: {
      generation: 1,
      version: sequence,
      observedAt: 1,
      workerState: "active",
      sessions: [row(id)],
      pending: [],
      workMemorySegments: [],
    },
  });
  const initial = Promise.withResolvers<MimiProjectionBaseline>();
  const retired = Promise.withResolvers<MimiProjectionBaseline>();
  const reads = [
    () => initial.promise,
    async () => baseline(5, "current"),
    () => retired.promise,
    async () => baseline(1, "new"),
  ];
  const mirror = new NativeMimiProjection(
    (async () => reads.shift()!()) as CallShellBusiness,
    () => {},
  );
  const starting = mirror.start();
  mirror.receive({
    sequence: 5,
    event: {
      kind: "session-upsert",
      generation: 1,
      version: 5,
      observedAt: 1,
      session: row("current"),
    },
  });
  initial.resolve(baseline(4, "old"));
  await starting;
  expect(mirror.getSnapshot().sessions.map((r) => r.agentSessionId)).toEqual(["current"]);
  const oldRead = mirror.start();
  mirror.disconnect();
  const next = mirror.start();
  await next;
  retired.resolve(baseline(9, "retired"));
  await oldRead;
  expect(mirror.getSnapshot().sessions.map((r) => r.agentSessionId)).toEqual(["new"]);
  mirror.stop();
});

test("worker-only deltas use the actual process generation and local approval revocation", async () => {
  const pushed = Promise.withResolvers<void>();
  const host = new HostedMimiProjection({
    catalog: async () => ({ sessions: [], nextCursor: null }),
    memory: async () => ({ epoch: "e", revision: 0, segments: [] }),
    worker: () => ({
      hasLiveWorker: () => true,
      petProjectionSnapshot: async () => ({
        workerGeneration: 1,
        snapshotVersion: 0,
        observedAt: 1,
        sessions: [],
        pending: [],
      }),
    }),
    external: async () => [],
    report: () => {},
    publish: (update) => {
      if (update.event.kind === "pending-upsert") pushed.resolve();
    },
  });
  try {
    host.workerState(4, "active");
    await host.start();
    const pending = {
      kind: "tool_approval",
      agentSessionId: "test-session",
      requestId: "fixture",
      title: "Approve fixture?",
      workerGeneration: 1,
      createdAt: 1,
      status: "pending",
    };
    const delta = {
      kind: "pending-upsert",
      workerGeneration: 1,
      version: 1,
      observedAt: 2,
      pending,
    };
    expect(
      host.observe(
        parseWorkerLine(
          JSON.stringify({ jsonrpc: "2.0", method: "agent/petProjectionDelta", params: delta }),
        ),
      ),
    ).toBe(true);
    expect(
      host.observe(
        parseWorkerLine(
          JSON.stringify({ jsonrpc: "2.0", method: "agent/streamEvent", params: {} }),
        ),
      ),
    ).toBe(false);
    await pushed.promise;
    expect((await host.snapshot()).pending).toMatchObject([
      { requestId: "fixture", workerGeneration: 4 },
    ]);
    host.workerState(4, "disconnected");
    await Bun.sleep(0);
    expect((await host.snapshot()).pending).toEqual([]);
  } finally {
    await host.close();
  }
});
