import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ExperimentLease } from "./lease.js";
import { ExperimentLedger, type LedgerUsage } from "./ledger.js";
import { ExperimentStore } from "./store.js";
import { fixture, grantFor } from "./test-fixtures/foundation.js";
import { canonicalJson, sha256Hex } from "./contracts/canonical-json.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup(overrides: Parameters<typeof fixture>[0] = {}) {
  const f = fixture(overrides);
  roots.push(f.root);
  return { ...f, ledger: new ExperimentLedger(f.store, f.now) };
}
function begin(
  f: ReturnType<typeof setup>,
  operationId = "op-a",
  role: "baseline" | "screening" | "optimizer" | "final" = "baseline",
  maxRequests = 2,
) {
  return f.ledger.beginOperation(f.id, f.fence, {
    operationId,
    role,
    timeoutMs: 1000,
    maxRequests,
    maxOutputTokens: 100,
  });
}
function reserve(
  f: ReturnType<typeof setup>,
  attemptId = "attempt-a",
  operationId = "op-a",
  estimatedTokens = 100,
  estimatedCostUsd: number | null = 0.01,
) {
  return f.ledger.reserveAttempt(f.id, f.fence, {
    operationId,
    attemptId,
    estimatedTokens,
    estimatedCostUsd,
  });
}
const usage: LedgerUsage = {
  inputTokens: 50,
  outputTokens: 20,
  cacheReadTokens: 10,
  cacheWriteTokens: 5,
  reasoningTokens: 5,
  reasoningIncludedInOutput: true,
};
function settle(
  f: ReturnType<typeof setup>,
  attemptId = "attempt-a",
  value: LedgerUsage | null = usage,
  actualCostUsd: number | null = 0.005,
) {
  f.ledger.settle(f.id, f.fence, {
    attemptId,
    usage: value,
    responseModel: "model",
    actualCostUsd,
  });
}

describe("durable request budget ledger", () => {
  test("every request has durable reserve and dispatch before settlement", () => {
    const f = setup();
    begin(f);
    reserve(f);
    const path = join(f.store.directory(f.id), "ledger.jsonl");
    expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
    expect(f.ledger.summary(f.id).attempts["attempt-a"].status).toBe("reserved");
    expect(() => settle(f)).toThrow("cannot settle");
    f.ledger.dispatch(f.id, f.fence, "attempt-a");
    settle(f);
    f.ledger.finishOperation(f.id, f.fence, "op-a", 40);
    const summary = new ExperimentLedger(new ExperimentStore(f.root)).summary(f.id);
    expect(summary.totals).toMatchObject({
      requests: 1,
      reportedTokens: 70,
      reservedTokens: 0,
      unknownTokens: 0,
      reportedCostUsd: 0.005,
      reportedExecutionMs: 40,
    });
    expect(summary.attempts["attempt-a"]).toMatchObject({
      owner: f.fence.owner,
      generation: f.fence.generation,
      grantRevision: 1,
    });
    expect(summary.operations["op-a"].grantRevision).toBe(1);
    const events = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.map((event) => event.kind)).toEqual([
      "operation_begin",
      "reserve",
      "dispatch",
      "settle",
      "operation_finish",
    ]);
    for (let index = 0; index < events.length; index++) {
      const { hash, ...content } = events[index];
      expect(events[index].sequence).toBe(index + 1);
      expect(events[index].previousHash).toBe(index === 0 ? null : events[index - 1].hash);
      expect(sha256Hex(canonicalJson(content))).toBe(hash);
    }
  });
  test("duplicate same settlement is idempotent; conflicting duplicate fails", () => {
    const f = setup();
    begin(f);
    reserve(f);
    f.ledger.dispatch(f.id, f.fence, "attempt-a");
    settle(f);
    const before = f.ledger.summary(f.id);
    settle(f);
    expect(f.ledger.summary(f.id)).toEqual(before);
    expect(() => settle(f, "attempt-a", { ...usage, outputTokens: 30 })).toThrow("conflicting");
    expect(() => reserve(f)).toThrow("already used");
  });
  test("no authorization, expiry, revocation and stop reject before request reservation", () => {
    const f = setup();
    begin(f);
    f.store.requestStop(f.id);
    expect(() => reserve(f)).toThrow("stop requested");
    expect(f.ledger.summary(f.id).totals.requests).toBe(0);
    const g = setup();
    begin(g);
    g.advance(120000);
    expect(() => reserve(g)).toThrow();
    expect(g.ledger.summary(g.id).totals.requests).toBe(0);
    const h = setup();
    begin(h);
    h.store.appendGrant(h.id, {
      ...h.grant,
      revision: 2,
      revokedAt: new Date(h.now()).toISOString(),
      revocationReason: "user",
    });
    expect(() => reserve(h)).toThrow("revoked");
    expect(h.ledger.summary(h.id).totals.requests).toBe(0);
    const noGrant = h.store.create(h.plan);
    const noGrantFence = new ExperimentLease(h.store).acquire(noGrant.state.id);
    expect(() =>
      h.ledger.beginOperation(noGrant.state.id, noGrantFence, {
        operationId: "x",
        role: "baseline",
        timeoutMs: 1000,
        maxRequests: 1,
        maxOutputTokens: 100,
      }),
    ).toThrow("not authorized");
  });
  test("operation deadline and execution window never reset across multiple HTTP requests", () => {
    const f = setup();
    const operation = begin(f);
    reserve(f);
    f.ledger.dispatch(f.id, f.fence, "attempt-a");
    settle(f);
    f.advance(500);
    const repeated = begin(f);
    expect(repeated.deadlineAt).toBe(operation.deadlineAt);
    const second = reserve(f, "attempt-b");
    expect(second.deadlineAt).toBe(operation.deadlineAt);
    expect(f.ledger.summary(f.id).totals.reservedExecutionMs).toBe(1000);
    f.advance(501);
    expect(() => f.ledger.dispatch(f.id, f.fence, "attempt-b")).toThrow("cannot dispatch");
    expect(() => begin(f, "other")).toThrow("another operation");
    expect(() =>
      f.ledger.beginOperation(f.id, f.fence, {
        operationId: "op-a",
        role: "baseline",
        timeoutMs: 2000,
        maxRequests: 2,
        maxOutputTokens: 100,
      }),
    ).toThrow("limits differ");
  });
  test("final resources stay ringfenced from search then are consumed by final trials", () => {
    const f = setup({
      maxRequests: 3,
      maxEstimatedTokens: 300,
      maxEstimatedCostUsd: 0.03,
      maxExecutionMs: 4000,
    });
    begin(f);
    reserve(f);
    f.ledger.dispatch(f.id, f.fence, "attempt-a");
    settle(f);
    f.ledger.finishOperation(f.id, f.fence, "op-a", 50);
    begin(f, "op-b");
    expect(() => reserve(f, "attempt-b", "op-b")).toThrow("request budget exhausted");
    f.ledger.finishOperation(f.id, f.fence, "op-b", 0);
    begin(f, "final-a", "final");
    reserve(f, "final-attempt-a", "final-a");
    f.ledger.dispatch(f.id, f.fence, "final-attempt-a");
    settle(f, "final-attempt-a");
    f.ledger.finishOperation(f.id, f.fence, "final-a", 20);
    expect(f.ledger.summary(f.id).finalAllocation).toEqual({
      requests: 1,
      estimatedTokens: 100,
      estimatedCostUsd: 0.01,
      executionMs: 1000,
    });
    begin(f, "final-b", "final");
    reserve(f, "final-attempt-b", "final-b");
    f.ledger.dispatch(f.id, f.fence, "final-attempt-b");
    settle(f, "final-attempt-b");
    f.ledger.finishOperation(f.id, f.fence, "final-b", 20);
    expect(f.ledger.summary(f.id).finalAllocation).toEqual({
      requests: 0,
      estimatedTokens: 0,
      estimatedCostUsd: 0,
      executionMs: 0,
    });
    expect(f.ledger.summary(f.id).totals.requests).toBe(3);
  });
  test("all final budget locked prevents any search operation", () => {
    const f = setup({
      maxRequests: 2,
      maxEstimatedTokens: 200,
      maxEstimatedCostUsd: 0.02,
      maxExecutionMs: 2000,
    });
    expect(() => begin(f)).toThrow("execution budget exhausted");
    expect(f.ledger.summary(f.id).sequence).toBe(0);
  });
  test("unknown usage preserves reservation and unknown crash window survives renewal", () => {
    const f = setup();
    begin(f);
    reserve(f);
    f.ledger.dispatch(f.id, f.fence, "attempt-a");
    settle(f, "attempt-a", null);
    f.ledger.recoverUnknown(f.id, f.fence);
    const before = f.ledger.summary(f.id);
    expect(before.totals).toMatchObject({
      requests: 1,
      unknownTokens: 100,
      unknownCostUsd: 0.01,
      unknownExecutionMs: 1000,
    });
    f.store.appendGrant(f.id, grantFor(f.plan.planHash, f.now(), { revision: 2, maxRequests: 20 }));
    expect(new ExperimentLedger(new ExperimentStore(f.root)).summary(f.id).totals).toEqual(
      before.totals,
    );
    f.ledger.recoverUnknown(f.id, f.fence);
    expect(f.ledger.summary(f.id).totals).toEqual(before.totals);
  });
  test("unknown monetary estimates cannot satisfy a finite cost threshold", () => {
    const f = setup();
    begin(f);
    expect(() => reserve(f, "unknown-price", "op-a", 100, null)).toThrow("unknown cost");
    expect(f.ledger.summary(f.id).totals.requests).toBe(0);
    const g = setup({ maxEstimatedCostUsd: null });
    begin(g);
    reserve(g, "unknown-price", "op-a", 100, null);
    g.ledger.dispatch(g.id, g.fence, "unknown-price");
    settle(g, "unknown-price", usage, null);
    expect(g.ledger.summary(g.id).totals.unknownCostAttempts).toBe(1);
  });
  test("input/cache/reasoning accounting is independent and never double counted", () => {
    const f = setup();
    begin(f);
    reserve(f);
    f.ledger.dispatch(f.id, f.fence, "attempt-a");
    settle(f, "attempt-a", { ...usage, reasoningIncludedInOutput: false });
    expect(f.ledger.summary(f.id).totals.reportedTokens).toBe(75);
    const g = setup();
    begin(g);
    reserve(g);
    g.ledger.dispatch(g.id, g.fence, "attempt-a");
    settle(g, "attempt-a", { ...usage, reasoningIncludedInOutput: false, reasoningTokens: null });
    expect(g.ledger.summary(g.id).totals.unknownTokens).toBe(100);
    const h = setup();
    begin(h);
    reserve(h);
    h.ledger.dispatch(h.id, h.fence, "attempt-a");
    expect(() => settle(h, "attempt-a", { ...usage, cacheReadTokens: 60 })).toThrow("cache usage");
    expect(h.ledger.summary(h.id).attempts["attempt-a"].status).toBe("dispatched");
  });
  test("usage exceeding reservation invalidates estimate and prevents new calls", () => {
    const f = setup();
    begin(f);
    reserve(f, "attempt-a", "op-a", 20);
    f.ledger.dispatch(f.id, f.fence, "attempt-a");
    settle(f);
    expect(f.ledger.summary(f.id).estimateInvalid).toBe(true);
    expect(() => reserve(f, "attempt-b")).toThrow("estimate invalidated");
  });
  test("larger candidate final needs checked against remaining budget without changing denominator", () => {
    const f = setup({ maxEstimatedTokens: 300 });
    expect(() =>
      f.ledger.setFinalAllocation(f.id, f.fence, {
        ...f.plan.finalAllocation,
        estimatedTokens: 301,
      }),
    ).toThrow("token estimate budget exhausted");
    expect(f.ledger.summary(f.id).finalAllocation).toEqual(f.plan.finalAllocation);
    f.ledger.setFinalAllocation(f.id, f.fence, { ...f.plan.finalAllocation, estimatedTokens: 250 });
    expect(f.ledger.summary(f.id).finalAllocation.estimatedTokens).toBe(250);
  });
  test("new lease owner must convert old operation to unknown; old owner cannot settle late", () => {
    const f = setup();
    begin(f);
    reserve(f);
    f.ledger.dispatch(f.id, f.fence, "attempt-a");
    f.advance(15001);
    const other = new ExperimentLease(f.store, { owner: "replacement", now: f.now });
    const nextFence = other.acquire(f.id);
    expect(() => settle(f)).toThrow("lease lost");
    expect(() =>
      f.ledger.settle(f.id, nextFence, {
        attemptId: "attempt-a",
        usage,
        responseModel: "model",
        actualCostUsd: 0.005,
      }),
    ).toThrow("cannot settle");
    expect(() =>
      f.ledger.reserveAttempt(f.id, nextFence, {
        operationId: "op-a",
        attemptId: "new",
        estimatedTokens: 100,
        estimatedCostUsd: 0.01,
      }),
    ).toThrow();
    f.ledger.recoverUnknown(f.id, nextFence);
    expect(f.ledger.summary(f.id).totals).toMatchObject({
      unknownTokens: 100,
      unknownExecutionMs: 1000,
    });
  });
  test("truncated tail repaired with evidence; middle corruption or gap fails closed", () => {
    const f = setup();
    begin(f);
    reserve(f);
    const path = join(f.store.directory(f.id), "ledger.jsonl");
    const good = readFileSync(path, "utf8");
    appendFileSync(path, '{"incomplete":');
    expect(f.ledger.summary(f.id).totals.requests).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(good);
    const evidence = readdirSync(join(f.store.directory(f.id), "ledger-repairs"));
    expect(evidence).toHaveLength(1);
    expect(
      readFileSync(join(f.store.directory(f.id), "ledger-repairs", evidence[0]), "utf8"),
    ).toContain("incomplete");
    writeFileSync(path, good.replace('"sequence":1', '"sequence":3'));
    expect(() => f.ledger.summary(f.id)).toThrow("hash chain");
    expect(() => reserve(f, "attempt-b")).toThrow("hash chain");
    writeFileSync(path, good.split("\n")[0] + "\nINVALID\n");
    expect(() => f.ledger.summary(f.id)).toThrow("corrupt ledger");
  });
  test("operation limits and final denominator cannot be changed to bypass budget", () => {
    const f = setup();
    for (const patch of [{ timeoutMs: 1 }, { maxRequests: 1 }, { maxOutputTokens: 1 }]) {
      expect(() =>
        f.ledger.beginOperation(f.id, f.fence, {
          operationId: "bad",
          role: "baseline",
          timeoutMs: 1000,
          maxRequests: 2,
          maxOutputTokens: 100,
          ...patch,
        }),
      ).toThrow("frozen plan");
    }
    expect(() =>
      f.ledger.setFinalAllocation(f.id, f.fence, { ...f.plan.finalAllocation, requests: 1 }),
    ).toThrow("denominator");
    expect(() =>
      f.ledger.setFinalAllocation(f.id, f.fence, { ...f.plan.finalAllocation, executionMs: 1000 }),
    ).toThrow("denominator");
    expect(f.ledger.summary(f.id).sequence).toBe(0);
  });
  test("ledger copied from another experiment fails plan and experiment binding", () => {
    const f = setup();
    begin(f);
    reserve(f);
    const second = f.store.create(f.plan);
    writeFileSync(
      join(f.store.directory(second.state.id), "ledger.jsonl"),
      readFileSync(join(f.store.directory(f.id), "ledger.jsonl")),
    );
    expect(() => f.ledger.summary(second.state.id)).toThrow("hash chain");
  });
  test("mixed roles share one cumulative budget and retain reservation revisions", () => {
    const f = setup();
    for (const [index, role] of (["baseline", "screening", "optimizer"] as const).entries()) {
      const limits = role === "optimizer" ? f.plan.bounds.optimization : f.plan.bounds.trial;
      const operationId = `mixed-${index}`;
      f.ledger.beginOperation(f.id, f.fence, { operationId, role, ...limits });
      reserve(f, `attempt-${index}`, operationId);
      f.ledger.dispatch(f.id, f.fence, `attempt-${index}`);
      settle(f, `attempt-${index}`);
      f.ledger.finishOperation(f.id, f.fence, operationId, 10);
    }
    expect(f.ledger.summary(f.id).totals).toMatchObject({
      requests: 3,
      reportedTokens: 210,
      reportedExecutionMs: 30,
    });
    f.store.appendGrant(f.id, grantFor(f.plan.planHash, f.now(), { revision: 2, maxRequests: 20 }));
    begin(f, "after-renewal");
    reserve(f, "renewed", "after-renewal");
    expect(f.ledger.summary(f.id).attempts.renewed.grantRevision).toBe(2);
    expect(f.ledger.summary(f.id).attempts["attempt-0"].grantRevision).toBe(1);
  });
  test("partial known usage remains auditable while full estimate stays unknown", () => {
    const f = setup();
    begin(f);
    reserve(f);
    f.ledger.dispatch(f.id, f.fence, "attempt-a");
    const partial = { ...usage, outputTokens: null };
    settle(f, "attempt-a", partial);
    const summary = f.ledger.summary(f.id);
    expect(summary.attempts["attempt-a"].usage).toEqual(partial);
    expect(summary.totals.unknownTokens).toBe(100);
    expect(summary.totals.reportedTokens).toBe(0);
  });
  test("missing or rolled-back ledger cannot reset already spent budget", () => {
    const f = setup();
    begin(f);
    reserve(f);
    const directory = f.store.directory(f.id);
    const path = join(directory, "ledger.jsonl");
    const original = readFileSync(path, "utf8");
    rmSync(path);
    expect(() => f.ledger.summary(f.id)).toThrow("ledger missing");
    writeFileSync(path, "");
    expect(() => f.ledger.summary(f.id)).toThrow("durable head");
    writeFileSync(path, original.split("\n")[0] + "\n");
    expect(() => f.ledger.summary(f.id)).toThrow("durable head");
    writeFileSync(path, original);
    expect(f.ledger.summary(f.id).totals.requests).toBe(1);
    rmSync(join(directory, "ledger-head.json"));
    expect(() => f.ledger.summary(f.id)).toThrow("head missing");
  });
  test("crash after durable event before head update reconciles forward", () => {
    const f = setup();
    begin(f);
    const directory = f.store.directory(f.id);
    const headPath = join(directory, "ledger-head.json");
    const previousHead = readFileSync(headPath, "utf8");
    reserve(f);
    writeFileSync(headPath, previousHead);
    const summary = f.ledger.summary(f.id);
    expect(summary.totals.requests).toBe(1);
    expect(JSON.parse(readFileSync(headPath, "utf8"))).toMatchObject({
      sequence: summary.sequence,
      hash: summary.headHash,
    });
  });
  test("unstarted final HTTP preserves its future window after failed admission", () => {
    const f = setup();
    begin(f, "final-before", "final");
    expect(() => reserve(f, "bad-price", "final-before", 100, null)).toThrow("unknown cost");
    f.ledger.finishOperation(f.id, f.fence, "final-before", 0);
    expect(f.ledger.summary(f.id).finalAllocation).toEqual(f.plan.finalAllocation);
    begin(f, "final-retry", "final");
    reserve(f, "allowed", "final-retry");
    expect(f.ledger.summary(f.id).totals.requests).toBe(1);
  });
  test("repair path cannot be a symlink", () => {
    const f = setup();
    begin(f);
    const directory = f.store.directory(f.id);
    const path = join(directory, "ledger.jsonl");
    symlinkSync(f.root, join(directory, "ledger-repairs"));
    appendFileSync(path, "truncated");
    expect(() => f.ledger.summary(f.id)).toThrow("unsafe ledger repair");
  });
});

test("SIGKILL after dispatch retains unknown expenditure on replacement process", async () => {
  const f = setup();
  f.lease.release(f.id, f.fence);
  const storeUrl = new URL("./store.ts", import.meta.url).href;
  const leaseUrl = new URL("./lease.ts", import.meta.url).href;
  const ledgerUrl = new URL("./ledger.ts", import.meta.url).href;
  // Test crash recovery, not whether three durable writes finish within 100ms.
  // Use the grant's fixture clock in both processes; advance it after SIGKILL.
  const childNow = f.now();
  const script = `import { ExperimentStore } from ${JSON.stringify(storeUrl)}; import { ExperimentLease } from ${JSON.stringify(leaseUrl)}; import { ExperimentLedger } from ${JSON.stringify(ledgerUrl)}; const store=new ExperimentStore(process.argv[1]); const id=process.argv[2]; const now=()=>Number(process.argv[3]); const lease=new ExperimentLease(store,{owner:'crashing',ttlMs:100,now}); const fence=lease.acquire(id); const ledger=new ExperimentLedger(store,now); ledger.beginOperation(id,fence,{operationId:'crash-op',role:'baseline',timeoutMs:1000,maxRequests:2,maxOutputTokens:100}); ledger.reserveAttempt(id,fence,{operationId:'crash-op',attemptId:'crash-attempt',estimatedTokens:100,estimatedCostUsd:0.01}); ledger.dispatch(id,fence,'crash-attempt'); console.log('dispatched'); setInterval(()=>{},1000); await new Promise(()=>{});`;
  const child = Bun.spawn([process.execPath, "-e", script, f.root, f.id, String(childNow)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  const startedAt = Date.now();
  const stderrReader = child.stderr.getReader();
  let stderr = "";
  const stderrDone = (async () => {
    try {
      for (;;) {
        const chunk = await stderrReader.read();
        if (chunk.done) return;
        stderr += new TextDecoder().decode(chunk.value);
        if (stderr.length > 32_768) {
          stderr = `${stderr.slice(0, 32_768)} [truncated]`;
          await stderrReader.cancel();
          return;
        }
      }
    } finally {
      stderrReader.releaseLock();
    }
  })();
  try {
    const first = await reader.read();
    const stdout = new TextDecoder().decode(first.value);
    if (!stdout.includes("dispatched")) {
      if (child.exitCode === null) child.kill("SIGKILL");
      const exitCode = await child.exited;
      await stderrDone;
      throw new Error(
        `Dispatch child exited before its receipt: ${JSON.stringify({
          executable: process.execPath,
          pid: child.pid,
          elapsedMs: Date.now() - startedAt,
          done: first.done,
          exitCode,
          stdout,
          stderr,
        })}`,
      );
    }
    expect(stdout).toContain("dispatched");
    child.kill("SIGKILL");
    await child.exited;
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    reader.releaseLock();
    await stderrDone;
  }
  const snapshot = f.store.read(f.id);
  expect(snapshot.lease).toMatchObject({
    owner: "crashing",
    heartbeatAt: childNow,
    expiresAt: childNow + 100,
  });
  f.advance(snapshot.lease!.expiresAt - f.now() + 1);
  const replacement = new ExperimentLease(f.store, { owner: "replacement", now: f.now });
  const fence = replacement.acquire(f.id);
  f.ledger.recoverUnknown(f.id, fence);
  const recovered = f.ledger.summary(f.id);
  expect(recovered.totals).toMatchObject({
    requests: 1,
    unknownTokens: 100,
    unknownCostUsd: 0.01,
    unknownExecutionMs: 1000,
  });
  expect(recovered.attempts["crash-attempt"].status).toBe("unknown");
  expect(
    f.ledger.beginOperation(f.id, fence, {
      operationId: "crash-op",
      role: "baseline",
      timeoutMs: 1000,
      maxRequests: 2,
      maxOutputTokens: 100,
    }).status,
  ).toBe("unknown");
}, 10000);
