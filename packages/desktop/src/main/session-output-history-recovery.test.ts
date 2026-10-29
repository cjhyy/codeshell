import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, sessionsRoot } from "@cjhyy/code-shell-core";
import { SessionOutputCoverageStore } from "@cjhyy/code-shell-core/internal";
import { ExternalRuntimeSessionRecorder } from "./external-runtime-state.js";
import { SessionSnapshotStore } from "./SessionSnapshotStore.js";
import { SessionOutputHistoryRecovery } from "./session-output-history-recovery.js";
import {
  assertOutputHistoryWriteAvailable,
  outputHistoryRecoveryRevision,
} from "./session-output-history-lease.js";
import { registerSessionTranscriptIpc } from "./session-transcript-ipc.js";
import { recoverDesktopOutputJournal } from "../renderer/app/outputJournalRecovery.js";

let previous: string | undefined, directory: string;
beforeEach(() => {
  previous = process.env.CODE_SHELL_HOME;
  directory = mkdtempSync(join(tmpdir(), "host-history-recovery-"));
  process.env.CODE_SHELL_HOME = directory;
});
afterEach(() => {
  if (previous === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = previous;
  rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const id = `history-${Math.random().toString(36).slice(2)}`;
  const recorder = new ExternalRuntimeSessionRecorder(id, directory, "fixture", "codex");
  const coverage = new SessionOutputCoverageStore(sessionsRoot);
  const snapshots = new SessionSnapshotStore({ coverage });
  snapshots.append(
    id,
    recorder.beginTurn({ text: "synthetic question", clientMessageId: "input" }),
  );
  snapshots.append(id, recorder.startEvent());
  snapshots.append(
    id,
    recorder.onEvent({ type: "stream_request_start", turnNumber: 1, messageId: "reply" })!,
  );
  snapshots.append(id, recorder.onEvent({ type: "text_delta", text: "synthetic answer" })!);
  snapshots.append(id, recorder.onEvent({ type: "turn_complete", reason: "completed" })!);
  snapshots.append(id, {
    type: "background_agent_completed",
    agentId: "old",
    description: "old notification",
    status: "completed",
    enqueuedAt: 1,
  });
  let revoked = false,
    busy = false,
    resetFails = false,
    retirementFails = false,
    retired = 0,
    closed = 0;
  let pause: Promise<void> | undefined;
  const service = new SessionOutputHistoryRecovery({
    bridge: () => ({
      isSessionRunning: () => busy,
      getSnapshot: (id) => snapshots.get(id),
      async quiesceForOutputRecovery() {
        closed++;
        await pause;
      },
      resetOutputHistoryRecovery: (id) => {
        if (resetFails) throw new Error("reset failed");
        snapshots.resetForHistoryCheckpoint(id);
      },
    }),
    external: () => null,
    authorize: async (_id, caller) => ({
      key: JSON.stringify(caller),
      ownerWebContentsId: undefined,
      projectId: null,
      assertCurrent() {
        if (revoked) throw new Error("revoked");
      },
    }),
    assertBackgroundIdle() {
      if (busy) throw new Error("background work");
    },
    retire() {
      if (retirementFails) throw new Error("retire failed");
      retired++;
    },
  });
  const caller = { kind: "mobile" as const, deviceId: "paired", viewerId: "viewer" };
  return {
    id,
    service,
    snapshots,
    recorder,
    caller,
    revoke: () => {
      revoked = true;
    },
    setBusy: () => {
      busy = true;
    },
    pause: (value: Promise<void>) => {
      pause = value;
    },
    failRetirement: (value: boolean) => {
      retirementFails = value;
    },
    failReset: (value: boolean) => {
      resetFails = value;
    },
    closed: () => closed,
    retired: () => retired,
  };
}

test("confirmed Host recovery fences pending ingress and fully reloads canonical history before a new turn", async () => {
  const f = fixture(),
    plan = await f.service.plan(f.id, f.caller);
  expect(plan.status).toBe("ready");
  if (plan.status !== "ready") return;
  const before = f.snapshots.get(f.id),
    revision = outputHistoryRecoveryRevision(f.id);
  let resume!: () => void;
  f.pause(
    new Promise<void>((resolve) => {
      resume = resolve;
    }),
  );
  const pending = f.service.apply(
    f.id,
    { planId: plan.planId, acceptHistoricalGap: true },
    f.caller,
  );
  for (let attempt = 0; attempt < 100 && !f.closed(); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(f.closed()).toBe(1);
  expect(() => assertOutputHistoryWriteAvailable(f.id, revision)).toThrow();
  resume();
  expect((await pending).status).toBe("applied");
  const after = f.snapshots.get(f.id);
  expect(after).toMatchObject({ nextSeq: before.nextSeq, historicalGap: true });
  expect(after.outputUnpaired).not.toBe(true);
  expect(() => assertOutputHistoryWriteAvailable(f.id, revision)).toThrow();
  expect(() => assertOutputHistoryWriteAvailable(f.id)).not.toThrow();
  expect(f.retired()).toBe(1);
  const handlers = new Map<string, (...args: any[]) => any>();
  registerSessionTranscriptIpc({ handle: (name, handler) => handlers.set(name, handler) });
  const result = await recoverDesktopOutputJournal({
    read: (options) => handlers.get("sessions:outputJournal")!({}, f.id, options),
    snapshot: async () => f.snapshots.get(f.id) as any,
    canContinue: () => true,
    latestObservedCursor: () => undefined,
  });
  expect(result?.state.messages).toContainEqual(
    expect.objectContaining({ kind: "assistant", text: "synthetic answer" }),
  );
  expect(result?.snapshot.historicalGap).toBe(true);
  expect(() => f.recorder.recordIndependentOutput({ type: "error", error: "late" })).toThrow();
  const next = new ExternalRuntimeSessionRecorder(f.id, directory, "fixture", "codex");
  f.snapshots.append(f.id, next.beginTurn({ text: "explicit new question" }));
  f.snapshots.append(f.id, next.onEvent({ type: "turn_complete", reason: "completed" })!);
  expect(f.snapshots.get(f.id).outputUnpaired).not.toBe(true);
  expect(new SessionManager().readSessionState(f.id)?.outputHistoryRecovery?.historicalGap).toBe(
    true,
  );
});

test("a fresh plan finishes failed snapshot retirement without another epoch", async () => {
  const f = fixture(),
    plan = await f.service.plan(f.id, f.caller);
  if (plan.status !== "ready") throw new Error("fixture plan failed");
  f.failReset(true);
  expect(
    await f.service.apply(f.id, { planId: plan.planId, acceptHistoricalGap: true }, f.caller),
  ).toMatchObject({ status: "blocked", reason: "storage_error" });
  const first = new SessionManager().readSessionState(f.id)!.outputHistoryRecovery!.recoveryId;
  expect(() => assertOutputHistoryWriteAvailable(f.id)).toThrow();
  f.failReset(false);
  // A snapshot failure must not postpone independent revocation of other viewers.
  expect(f.retired()).toBe(1);
  expect(await f.service.plan(f.id, f.caller)).toMatchObject({
    status: "blocked",
    reason: "not_needed",
  });
  expect(() => assertOutputHistoryWriteAvailable(f.id)).not.toThrow();
  expect(new SessionManager().readSessionState(f.id)!.outputHistoryRecovery!.recoveryId).toBe(
    first,
  );
});

test("backs up current and legacy projections for every Main catalog alias", async () => {
  const f = fixture();
  const { SessionCatalogStore } = await import("./session-catalog-store.js");
  await new SessionCatalogStore().importLegacy({
    project: {
      sessions: [
        { id: "ui-alias", engineSessionId: f.id, title: "synthetic", createdAt: 1, updatedAt: 1 },
      ],
      activeSessionId: "ui-alias",
    },
  });
  const hash = createHash("sha256")
    .update(JSON.stringify(["project", "ui-alias"]))
    .digest("hex");
  for (const kind of ["transcript-cache", "legacy-transcript-cache"]) {
    const path = join(directory, "desktop", kind);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, hash + ".json"), JSON.stringify({ synthetic: kind }));
  }
  const plan = await f.service.plan(f.id, f.caller);
  if (plan.status !== "ready") throw new Error("fixture plan failed");
  expect(
    (await f.service.apply(f.id, { planId: plan.planId, acceptHistoricalGap: true }, f.caller))
      .status,
  ).toBe("applied");
  const record = new SessionManager().readSessionState(f.id)!.outputHistoryRecovery!;
  const archive = join(sessionsRoot(), f.id, ".output-history-recovery", record.recoveryId);
  const aliases = readdirSync(archive).filter((name) => /^(current|legacy)-/.test(name));
  expect(aliases.length).toBe(2);
  expect(
    aliases.map((name) => JSON.parse(readFileSync(join(archive, name), "utf8")).synthetic).sort(),
  ).toEqual(["legacy-transcript-cache", "transcript-cache"]);
});

test.each(["throw", "blocked"])(
  "a %s after durable commit still retires the old snapshot and reports the storage fault",
  async (failure) => {
    const f = fixture(),
      plan = await f.service.plan(f.id, f.caller);
    if (plan.status !== "ready") throw new Error("fixture plan failed");
    const core = (f.service as any).recovery;
    const apply = core.apply.bind(core);
    core.apply = (...args: any[]) => {
      const result = apply(...args);
      expect(result.status).toBe("applied");
      if (failure === "throw") throw new Error("synthetic lease release failure");
      return { status: "blocked", sessionId: f.id, reason: "storage_error" };
    };
    expect(
      await f.service.apply(f.id, { planId: plan.planId, acceptHistoricalGap: true }, f.caller),
    ).toMatchObject({ status: "blocked", reason: "storage_error" });
    expect(f.snapshots.get(f.id).outputUnpaired).not.toBe(true);
    expect(f.snapshots.get(f.id).historicalGap).toBe(true);
    expect(f.retired()).toBe(1);
    expect(() => assertOutputHistoryWriteAvailable(f.id)).not.toThrow();
    expect(await f.service.plan(f.id, f.caller)).toMatchObject({
      status: "blocked",
      reason: "not_needed",
    });
  },
);

test.each(["wrong owner", "revoked", "busy", "generation"] as const)(
  "Host refuses %s before closing any runtime",
  async (reason) => {
    const f = fixture(),
      plan = await f.service.plan(f.id, f.caller);
    if (plan.status !== "ready") throw new Error("fixture plan failed");
    let caller = f.caller;
    if (reason === "wrong owner") caller = { ...caller, viewerId: "another-viewer" };
    if (reason === "revoked") f.revoke();
    if (reason === "busy") f.setBusy();
    if (reason === "generation") new SessionManager().incrementSessionGeneration(f.id);
    expect(
      (await f.service.apply(f.id, { planId: plan.planId, acceptHistoricalGap: true }, caller))
        .status,
    ).not.toBe("applied");
    expect(f.closed()).toBe(0);
    expect(new SessionManager().readSessionState(f.id)?.outputCoverage?.unpaired).toBe(true);
  },
);

test("a failed cross-viewer retirement retains the write fence and retries without a second epoch", async () => {
  const f = fixture(),
    plan = await f.service.plan(f.id, f.caller);
  if (plan.status !== "ready") throw new Error("fixture plan failed");
  const input = { planId: plan.planId, acceptHistoricalGap: true as const };
  f.failRetirement(true);
  expect(await f.service.apply(f.id, input, f.caller)).toMatchObject({
    status: "blocked",
    reason: "storage_error",
  });
  const first = new SessionManager().readSessionState(f.id)!.outputHistoryRecovery!.recoveryId;
  expect(() => assertOutputHistoryWriteAvailable(f.id)).toThrow();
  f.failRetirement(false);
  expect((await f.service.apply(f.id, input, f.caller)).status).toBe("applied");
  expect(() => assertOutputHistoryWriteAvailable(f.id)).not.toThrow();
  expect(new SessionManager().readSessionState(f.id)!.outputHistoryRecovery!.recoveryId).toBe(
    first,
  );
  expect(f.closed()).toBe(1);
});
