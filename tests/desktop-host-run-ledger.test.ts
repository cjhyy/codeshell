import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { UsageLedger } from "../packages/core/src/cost-ledger/store.js";
import { HostRunOperations } from "../packages/desktop/src/host/composition/run-operations.js";
import { RunOperationStorage } from "../packages/desktop/src/host/composition/run-operation-storage.js";
import { WorkerRunOperations } from "../packages/desktop/src/main/desktop-host/worker-run-operations.js";
import {
  DesktopHostServer,
  type HostPort,
} from "../packages/desktop/src/main/desktop-host/server.js";
import { remoteRunLedger } from "../packages/core/src/operations/host-transport.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codeshell-run-ops-"));
  roots.push(root);
  const key = { wrapped: "enc:fixture:ledger", secret: randomBytes(32).toString("hex") };
  const sid = "fixture",
    runId = "first";
  const usage = new UsageLedger({ storageDir: join(root, ".usage-ledger") });
  mkdirSync(join(root, sid));
  const state = {
    sessionId: sid,
    startedAt: 1,
    status: "active",
    runId,
    cwd: root,
    costState: usage.sessionState(sid, root),
  };
  const save = () => writeFileSync(join(root, sid, "state.json"), JSON.stringify(state));
  save();
  let pause: (() => Promise<void>) | undefined;
  const data = new RunOperationStorage(root);
  const file = join(root, ".operations", "ledger.json");
  let stagedKey: typeof key | undefined;
  const host = new HostRunOperations(
    Promise.resolve({
      async request<T>(cmd: string, input?: unknown) {
        if (cmd === "operations/endRun") return data.end((input as { token: string }).token) as T;
        if (cmd !== "operations/run") throw new Error(cmd);
        await pause?.();
        return data.run(input as Parameters<typeof data.run>[0]) as T;
      },
    }),
    async (create) => {
      if (stagedKey) {
        const value = stagedKey;
        stagedKey = undefined;
        return value;
      }
      return create || existsSync(file) ? key : null;
    },
    (id) => server.captureWorkerOperation(id),
  );
  const server = new DesktopHostServer("v", new Map(), () => host.authorityChanged());
  const frame = (gen: number) => ({
    webContentsId: 42,
    frameGeneration: gen,
    frameToken: "fixture-" + gen,
    windowKind: "workbench" as const,
  });
  const bind = (gen: number) =>
    server.bind(frame(gen), { start() {}, close() {}, on() {}, postMessage() {} } as HostPort);
  bind(1);
  server.setOwner(sid, 42);
  const runs = new WorkerRunOperations(host, () => true);
  const start = (run = runId) =>
    runs.observe({
      method: "agent/streamEvent",
      params: { sessionId: sid, event: { type: "session_started", sessionId: sid, runId: run } },
    });
  const ledger = (run = runId) => remoteRunLedger(sid, run, (req) => runs.run(req, () => true));
  const plan = {
    sessionId: sid,
    intentId: "fixture",
    channel: "local-link",
    action: "create_issue",
    service: "github",
    account: "fixture",
    target: { owner: "owner", repo: "project" },
    parameters: { body: "private-body" },
    postcondition: {},
  };
  return {
    key,
    file,
    plan,
    start,
    ledger,
    bind,
    server,
    runs,
    host,
    sid,
    state,
    save,
    frame,
    stageKey: (next: typeof key) => {
      stagedKey = next;
    },
    pause: (fn: () => Promise<void>) => {
      pause = fn;
    },
  };
}

test("a Run obtains only its issued receipt; the protected key never leaves the Host", async () => {
  const f = fixture();
  f.start();
  const ledger = f.ledger();
  expect(await ledger.hasUnverifiedWrites(f.sid)).toBe(false);
  await expect(
    Promise.resolve(ledger.prepare({ ...f.plan, sessionId: "other" })),
  ).rejects.toThrow();
  const receipt = await ledger.prepare(f.plan);
  expect(JSON.stringify(receipt)).not.toContain(f.key.secret);
  expect(JSON.stringify(receipt)).not.toContain(f.key.wrapped);
  await expect(Promise.resolve(ledger.sealPending("0".repeat(64)))).rejects.toThrow();
  const claimed = await ledger.claim(receipt.id);
  expect(claimed.claimed).toBe(true);
  await ledger.settle(receipt.id, claimed.receipt.attemptId, "succeeded", {
    reference: { id: "123" },
  });
  await ledger.settle(receipt.id, claimed.receipt.attemptId, "verified", {});
  expect(await ledger.sealForFinalization(f.sid)).toBe(false);
  const text = readFileSync(f.file, "utf8");
  expect(text).toContain(f.key.wrapped);
  expect(text).not.toContain(f.key.secret);
  expect(text).not.toContain("private-body");
});

test.each(["worker", "window", "owner", "delete", "persisted-run"])(
  "a %s change fences a queued claim",
  async (reason) => {
    const f = fixture();
    f.start();
    const ledger = f.ledger();
    const receipt = await ledger.prepare(f.plan);
    const entered = Promise.withResolvers<void>(),
      resume = Promise.withResolvers<void>();
    f.pause(() => {
      entered.resolve();
      return resume.promise;
    });
    const claim = ledger.claim(receipt.id);
    await entered.promise;
    if (reason === "worker") f.runs.close();
    if (reason === "window") f.bind(2);
    if (reason === "owner") {
      f.server.setOwner(f.sid, 16);
      f.server.setOwner(f.sid, 42);
    }
    if (reason === "delete") {
      f.server.setDeleting(f.sid, true);
      f.server.setDeleting(f.sid, false);
    }
    if (reason === "persisted-run") {
      f.state.runId = "new";
      f.save();
    }
    resume.resolve();
    await expect(Promise.resolve(claim)).rejects.toThrow();
    expect(JSON.parse(readFileSync(f.file, "utf8")).records[receipt.id].state).toBe("planned");
  },
);

test("a new executor must establish an active Run and cannot replay a prior physical send", async () => {
  const f = fixture();
  f.start();
  const receipt = await f.ledger().prepare(f.plan);
  await f.ledger().claim(receipt.id);
  f.runs.close();
  await expect(Promise.resolve(f.ledger().sealPending(receipt.id))).rejects.toThrow();
  f.state.runId = "next";
  f.save();
  f.start("next");
  const next = f.ledger("next");
  await expect(Promise.resolve(next.sealPending(receipt.id))).rejects.toThrow();
  expect((await next.prepare(f.plan)).state).toBe("running");
  expect((await next.sealPending(receipt.id)).state).toBe("unknown");
  expect(await next.sealForFinalization(f.sid)).toBe(true);
});

test("fresh UI ownership can be assigned once; navigation before the first receipt revokes it", async () => {
  const f = fixture();
  f.server.setOwner(f.sid, null);
  f.start();
  f.server.setOwner(f.sid, 42);
  expect((await f.ledger().prepare(f.plan)).state).toBe("planned");
  f.runs.close();
  f.state.runId = "next";
  f.save();
  f.start("next");
  f.bind(2);
  await expect(Promise.resolve(f.ledger("next").prepare(f.plan))).rejects.toThrow();
});

test("a process-local Run uses the protected ledger without adopting a durable identity", async () => {
  const f = fixture();
  const ephemeralId = "qchat-fixture";
  const live = f.host.open(ephemeralId, "live", () => true);
  const local = remoteRunLedger(ephemeralId, "live", (req) => live.run(req), true);
  const receipt = await local.prepare({ ...f.plan, sessionId: ephemeralId });
  expect(receipt.state).toBe("planned");
  expect(JSON.parse(readFileSync(f.file, "utf8")).key).toBe(f.key.wrapped);
  expect(await local.sealForFinalization(ephemeralId)).toBe(false);
  live.close();
  f.start();
  const overlap = remoteRunLedger(f.sid, "first", (req) => f.runs.run(req, () => true), true);
  await expect(Promise.resolve(overlap.prepare(f.plan))).rejects.toThrow("durable");
});

test("concurrent first use reloads the canonical winner before preparing a receipt", async () => {
  const f = fixture();
  f.start();
  const first = await f.ledger().prepare(f.plan);
  f.runs.close();
  f.state.runId = "next";
  f.save();
  f.start("next");
  f.stageKey({ wrapped: "enc:fixture:lost-initialization", secret: "2".repeat(64) });
  expect((await f.ledger("next").prepare(f.plan)).id).toBe(first.id);
  expect(JSON.parse(readFileSync(f.file, "utf8")).key).toBe(f.key.wrapped);
});

test("finalizing an untouched Run fences subsequent prepares even when no global ledger exists", async () => {
  const f = fixture();
  f.start();
  const ledger = f.ledger();
  expect(await ledger.sealForFinalization(f.sid)).toBe(false);
  await expect(Promise.resolve(ledger.prepare(f.plan))).rejects.toThrow("finalized");
  expect(existsSync(f.file)).toBe(false);
});
