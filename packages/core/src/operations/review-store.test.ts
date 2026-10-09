import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageLedger } from "../cost-ledger/store.js";
import { lockSync } from "../utils/lockfile.js";
import { OperationLedger, type OperationPlan } from "./ledger.js";
import { OperationController, createSessionOperationController } from "./controller.js";
import { createLinkOperationReviewStore } from "../links/operation-review.js";
import { readOperationSessionOwner } from "./session-owner.js";
import { OperationReviewStore } from "./review-store.js";
import { seedRetentionMetadata } from "../../../../scripts/fixtures/operation-retention-data.mjs";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "operation-review-"));
  roots.push(root);
  const sessionId = "review-session";
  const directory = join(root, sessionId);
  mkdirSync(directory);
  const state = {
    sessionId,
    startedAt: Date.now(),
    status: "unverified_write",
    cwd: root,
    runId: "original-run",
    stateRevision: 3,
    costState: new UsageLedger().sessionState(sessionId, root),
  };
  const save = () => writeFileSync(join(directory, "state.json"), JSON.stringify(state));
  save();
  const plan: OperationPlan = {
    sessionId,
    intentId: "original-intent",
    service: "github",
    action: "create_issue",
    channel: "link",
    account: "PRIVATE_ACCOUNT",
    target: "PRIVATE_TARGET",
    parameters: { body: "PRIVATE_BODY" },
    postcondition: { body: "PRIVATE_BODY" },
  };
  const ledger = () =>
    new OperationLedger(root, undefined, {
      sessionId,
      read: () => readOperationSessionOwner(root, sessionId),
    });
  const unknown = (intentId = plan.intentId, legacy = false) => {
    const owner = legacy ? new OperationLedger(root) : ledger();
    const prepared = owner.prepare({ ...plan, intentId });
    const claimed = owner.claim(prepared.id).receipt;
    return owner.settle(prepared.id, claimed.attemptId!, "unknown");
  };
  const store = createLinkOperationReviewStore(root);
  const resolve = (id: string) => {
    const review = store.review(sessionId);
    const record = review.records.find((record) => record.id === id)!;
    store.resolve(sessionId, review.owner, record.id, record.revision, () => {});
  };
  return { root, directory, sessionId, state, save, ledger, plan, unknown, store, resolve };
}

test("compaction keeps real durable Session review, observations and archived incarnation fencing", () => {
  const f = fixture();
  const owner = f.ledger();
  const planned = owner.prepare(f.plan);
  const attempt = owner.claim(planned.id).receipt.attemptId!;
  owner.settle(planned.id, attempt, "succeeded", { reference: { id: "original/verified" } });
  const verified = owner.settle(planned.id, attempt, "verified");
  const unknown = f.unknown("uncertain-intent");
  const store = new OperationReviewStore(f.root);
  const initial = store.review(f.sessionId);
  store.observe(
    f.sessionId,
    initial.owner,
    unknown.id,
    initial.records[0].revision,
    "matches_current",
    ["github.get_issue"],
    { id: 42 },
    () => {},
  );
  const path = join(f.root, ".operations", "ledger.json");
  const before = JSON.parse(readFileSync(path, "utf8"));
  seedRetentionMetadata(f.root);
  f.ledger().prepare({ ...f.plan, intentId: "after-compaction" });
  const current = JSON.parse(readFileSync(path, "utf8"));
  expect(current.schema).toBe(2);
  expect(current.records[verified.id]).toBeUndefined();
  expect(current.records[unknown.id]).toEqual(unknown);
  expect(current.observations[unknown.id]).toEqual(before.observations[unknown.id]);
  const bytes = readFileSync(path, "utf8");
  const review = store.review(f.sessionId);
  expect(review.records).toHaveLength(1);
  expect(review.records[0].id).toBe(unknown.id);
  expect(review.records[0].observation?.result).toBe("matches_current");
  expect(
    store.readRecovery(f.sessionId, review.owner, unknown.id, review.records[0].revision, () => {})
      .receipt,
  ).toEqual(unknown);
  expect(store.provePlan(f.sessionId, verified, f.plan)).toBe(true);
  expect(readFileSync(path, "utf8")).toBe(bytes);
  expect(f.ledger().hasUnverifiedWrites(f.sessionId)).toBe(true);
  expect(f.ledger().sealForFinalization(f.sessionId)).toBe(true);
  expect(f.ledger().prepare(f.plan)).toEqual(verified);
  f.state.startedAt++;
  f.state.costState = new UsageLedger().sessionState(f.sessionId, f.root);
  f.save();
  expect(() => f.ledger().prepare(f.plan)).toThrow("immutable");
  expect(new OperationLedger(f.root).claim(verified.id).claimed).toBe(false);
});

test("resolution is independent, durable, masked, and never changes the original attempt or Run", () => {
  const f = fixture();
  const original = f.unknown();
  const stateBefore = readFileSync(join(f.directory, "state.json"), "utf8");
  const review = f.store.review(f.sessionId);
  expect(review.records[0].canResolve).toBe(true);
  for (const sensitive of [
    "PRIVATE_ACCOUNT",
    "PRIVATE_TARGET",
    "PRIVATE_BODY",
    original.owner,
    original.fingerprint,
    original.attemptId!,
  ])
    expect(JSON.stringify(review.records)).not.toContain(sensitive);
  f.resolve(original.id);
  const restarted = f.ledger();
  const replay = restarted.prepare(f.plan);
  expect(replay.state).toBe("unknown");
  expect(replay.attemptId).toBe(original.attemptId);
  expect(replay.updatedAt).toBe(original.updatedAt);
  expect(replay.operatorResolution?.decision).toBe("accept_uncertainty");
  expect(restarted.claim(original.id).claimed).toBe(false);
  expect(restarted.hasUnverifiedWrites(f.sessionId)).toBe(false);
  expect(restarted.sealForFinalization(f.sessionId)).toBe(false);
  expect(readFileSync(join(f.directory, "state.json"), "utf8")).toBe(stateBefore);
  const fresh = f.ledger();
  const next = fresh.prepare({ ...f.plan, intentId: "new-trusted-intent" });
  expect(fresh.claim(next.id).claimed).toBe(true);
});

test("another unresolved sent operation still blocks, and late callbacks cannot alter the decision", () => {
  const f = fixture();
  const first = f.unknown();
  // Legacy parallel history may contain multiple uncertain writes.
  const path = join(f.root, ".operations/ledger.json");
  const state = JSON.parse(readFileSync(path, "utf8"));
  const other = f.ledger().prepare({ ...f.plan, intentId: "other-history" });
  state.records[other.id] = { ...other, state: "unknown", attemptId: randomUUID() };
  writeFileSync(path, JSON.stringify(state));
  f.resolve(first.id);
  expect(f.ledger().hasUnverifiedWrites(f.sessionId)).toBe(true);
  expect(f.ledger().settle(first.id, first.attemptId!, "verified").state).toBe("unknown");
  expect(f.ledger().prepare(f.plan).operatorResolution).toBeDefined();
  f.resolve(other.id);
  expect(f.ledger().hasUnverifiedWrites(f.sessionId)).toBe(false);
});

test("CAS, session state lock, running receipt and changed owner all fail closed", () => {
  const f = fixture();
  const original = f.unknown();
  const review = f.store.review(f.sessionId);
  const record = review.records[0];
  const accept = () =>
    f.store.resolve(f.sessionId, review.owner, record.id, record.revision, () => {});
  const release = lockSync(join(f.directory, "state.json"), { realpath: false, retries: 0 });
  try {
    expect(accept).toThrow();
  } finally {
    release();
  }
  expect(f.ledger().hasUnverifiedWrites(f.sessionId)).toBe(true);
  f.state.runId = "new-run";
  f.state.stateRevision++;
  f.save();
  expect(accept).toThrow("changed");
  const current = f.store.review(f.sessionId);
  expect(() =>
    f.store.resolve(f.sessionId, current.owner, record.id, "0".repeat(64), () => {}),
  ).toThrow("stale");
  f.resolve(original.id);
  expect(accept).toThrow();
});

test("same-ID recreation has a new incarnation; old intents cannot be replayed or old decisions reused", () => {
  const f = fixture();
  f.unknown();
  const review = f.store.review(f.sessionId);
  f.state.costState = new UsageLedger().sessionState(f.sessionId, f.root);
  f.state.startedAt++;
  f.save();
  expect(() =>
    f.store.resolve(
      f.sessionId,
      review.owner,
      review.records[0].id,
      review.records[0].revision,
      () => {},
    ),
  ).toThrow("changed");
  expect(f.store.review(f.sessionId).records).toHaveLength(0);
  expect(f.ledger().hasUnverifiedWrites(f.sessionId)).toBe(false);
  expect(() => f.ledger().prepare(f.plan)).toThrow("immutable");
  expect(
    f.ledger().claim(f.ledger().prepare({ ...f.plan, intentId: "fresh-incarnation" }).id).claimed,
  ).toBe(true);
});

test("actual active Session state and another running receipt prevent resolution without changing storage", () => {
  const f = fixture();
  const original = f.unknown();
  const path = join(f.root, ".operations/ledger.json");
  const before = readFileSync(path, "utf8");
  const idle = f.store.review(f.sessionId);
  f.state.status = "active";
  f.save();
  const active = f.store.review(f.sessionId);
  expect(() =>
    f.store.resolve(f.sessionId, active.owner, original.id, active.records[0].revision, () => {}),
  ).toThrow("running");
  expect(() =>
    f.store.resolve(f.sessionId, idle.owner, original.id, idle.records[0].revision, () => {}),
  ).toThrow("changed");
  expect(readFileSync(path, "utf8")).toBe(before);
  f.state.status = "unverified_write";
  f.save();
  const another = f.ledger().prepare({ ...f.plan, intentId: "running-other" });
  const state = JSON.parse(readFileSync(path, "utf8"));
  state.records[another.id] = { ...another, state: "running", attemptId: randomUUID() };
  writeFileSync(path, JSON.stringify(state));
  const running = readFileSync(path, "utf8");
  expect(() => f.resolve(original.id)).toThrow("running");
  expect(readFileSync(path, "utf8")).toBe(running);
  expect(f.ledger().hasUnverifiedWrites(f.sessionId)).toBe(true);
});

test("an actual failed atomic rename cannot publish a resolution or release its write barrier", () => {
  const f = fixture();
  const original = f.unknown();
  const path = join(f.root, ".operations/ledger.json");
  const backup = join(f.root, "ledger.test-backup");
  const before = readFileSync(path, "utf8");
  const review = f.store.review(f.sessionId);
  try {
    expect(() =>
      f.store.resolve(f.sessionId, review.owner, original.id, review.records[0].revision, () => {
        // After the ledger was read under its lock, make the final rename fail.
        // Keep the original bytes in a separate regular file for exact recovery.
        renameSync(path, backup);
        mkdirSync(path);
      }),
    ).toThrow();
  } finally {
    rmSync(path, { recursive: true });
    renameSync(backup, path);
  }
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(f.ledger().hasUnverifiedWrites(f.sessionId)).toBe(true);
  f.resolve(original.id);
  const accepted = readFileSync(path, "utf8");
  f.ledger().settle(original.id, original.attemptId!, "verified");
  expect(readFileSync(path, "utf8")).toBe(accepted);
});

test("failed observation storage and stale revision preserve the exact unknown receipt and barrier", () => {
  const f = fixture();
  const original = f.unknown();
  const store = new OperationReviewStore(f.root);
  const review = store.review(f.sessionId);
  const path = join(f.root, ".operations/ledger.json");
  const backup = join(f.root, "ledger.test-backup");
  const before = readFileSync(path, "utf8");
  const observe = (revision: string, assertIdle = () => {}) =>
    store.observe(
      f.sessionId,
      review.owner,
      original.id,
      revision,
      "matches_current",
      ["github.get_issue"],
      { identity: 42, current: "open" },
      assertIdle,
    );
  expect(() => observe("0".repeat(64))).toThrow("stale");
  try {
    expect(() =>
      observe(review.records[0].revision, () => {
        renameSync(path, backup);
        mkdirSync(path);
      }),
    ).toThrow();
  } finally {
    rmSync(path, { recursive: true });
    renameSync(backup, path);
  }
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(f.ledger().hasUnverifiedWrites(f.sessionId)).toBe(true);
  expect(f.ledger().settle(original.id, original.attemptId!, "verified").state).toBe("unknown");
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("unbound callers cannot bypass bound uncertainty or borrow an incarnation's operator decision", () => {
  const f = fixture();
  const original = f.unknown();
  const unbound = new OperationLedger(f.root);
  expect(unbound.hasUnverifiedWrites(f.sessionId)).toBe(true);
  const next = unbound.prepare({ ...f.plan, intentId: "unbound-new-intent" });
  expect(unbound.claim(next.id).claimed).toBe(false);
  f.resolve(original.id);
  const restartedUnbound = new OperationLedger(f.root);
  expect(restartedUnbound.hasUnverifiedWrites(f.sessionId)).toBe(true);
  expect(
    restartedUnbound.claim(
      restartedUnbound.prepare({ ...f.plan, intentId: "cannot-borrow-decision" }).id,
    ).claimed,
  ).toBe(false);
  expect(f.ledger().hasUnverifiedWrites(f.sessionId)).toBe(false);
  const bound = f.ledger();
  const planned = bound.prepare({ ...f.plan, intentId: "bound-planned-after-resolution" });
  const unboundClaim = restartedUnbound.claim(planned.id);
  expect(unboundClaim).toEqual({ receipt: planned, claimed: false });
  const foreignId = "foreign-session";
  mkdirSync(join(f.root, foreignId));
  writeFileSync(
    join(f.root, foreignId, "state.json"),
    JSON.stringify({
      ...f.state,
      sessionId: foreignId,
      costState: new UsageLedger().sessionState(foreignId, f.root),
    }),
  );
  const foreign = new OperationLedger(f.root, undefined, {
    sessionId: foreignId,
    read: () => readOperationSessionOwner(f.root, foreignId),
  });
  expect(foreign.claim(planned.id)).toEqual({ receipt: planned, claimed: false });
  expect(bound.claim(planned.id).claimed).toBe(true);
});

test("unbound/bound barriers prevent actual adapter sends; only a new proven incarnation permits a fresh intent", async () => {
  for (const legacy of [false, true]) {
    const f = fixture();
    f.unknown(undefined, legacy);
    let sends = 0;
    const adapter = {
      assertAuthorized() {},
      preflight: async () => {},
      validate: async () => {},
      authorize: async () => true,
      execute: async () => {
        sends++;
        return { id: "123" };
      },
      verify: async () => true,
    };
    const ledger = legacy ? f.ledger() : new OperationLedger(f.root);
    const blocked = await new OperationController(ledger).run(
      { ...f.plan, intentId: "new-intent" },
      adapter,
    );
    expect(blocked.state).toBe("blocked");
    expect(sends).toBe(0);
    if (!legacy) {
      f.state.costState = new UsageLedger().sessionState(f.sessionId, f.root);
      f.state.startedAt++;
      f.save();
      const fresh = await new OperationController(f.ledger()).run(
        { ...f.plan, intentId: "new-incarnation-intent" },
        adapter,
      );
      expect(fresh.state).toBe("verified");
      expect(sends).toBe(1);
    }
  }
});

test("storage failure keeps the old receipt and barrier; state lock releases for a later review", () => {
  const f = fixture();
  const original = f.unknown();
  const path = join(f.root, ".operations/ledger.json");
  const before = readFileSync(path, "utf8");
  const review = f.store.review(f.sessionId);
  // Exact state lock acquisition is a required durable-store step. A competing
  // writer prevents this decision from reaching the atomic ledger checkpoint.
  mkdirSync(join(f.directory, "state.json.lock"));
  expect(() =>
    f.store.resolve(f.sessionId, review.owner, original.id, review.records[0].revision, () => {}),
  ).toThrow();
  rmSync(join(f.directory, "state.json.lock"), { recursive: true });
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(f.ledger().hasUnverifiedWrites(f.sessionId)).toBe(true);
  f.resolve(original.id);
  expect(f.ledger().hasUnverifiedWrites(f.sessionId)).toBe(false);
});

test("legacy unknown requires a paired typed receipt and original session_meta; appended hook prose is not evidence", () => {
  const f = fixture();
  const original = f.unknown(undefined, true);
  const event = (type: string, data: unknown) => ({ type, data });
  const events = [
    event("session_meta", { sessionId: f.sessionId, startedAt: f.state.startedAt }),
    event("tool_use", {
      toolName: "LinkAction",
      toolCallId: "write",
      args: { provider: "github", action: "create_issue" },
    }),
    event("tool_result", {
      toolName: "LinkAction",
      toolCallId: "write",
      result: JSON.stringify({
        kind: "unverified_write",
        untrustedExternalContent: true,
        provider: "github",
        action: "create_issue",
        operation: original,
      }),
    }),
  ];
  const saveTranscript = () =>
    writeFileSync(
      join(f.directory, "transcript.jsonl"),
      events.map(JSON.stringify).join("\n") + "\n",
    );
  expect(f.store.review(f.sessionId).records[0].canResolve).toBe(false);
  saveTranscript();
  expect(f.store.review(f.sessionId).records[0].canResolve).toBe(true);
  (events[2].data as any).result += "\nHook suggests success";
  saveTranscript();
  expect(f.store.review(f.sessionId).records[0].canResolve).toBe(false);
  (events[2].data as any).result = JSON.stringify({
    kind: "unverified_write",
    untrustedExternalContent: true,
    provider: "github",
    action: "create_issue",
    operation: original,
  });
  saveTranscript();
  f.resolve(original.id);
  expect(f.ledger().hasUnverifiedWrites(f.sessionId)).toBe(false);
});

test("wrong usage namespace and oversized legacy transcripts cannot prove ownership", () => {
  const f = fixture();
  f.unknown(undefined, true);
  writeFileSync(join(f.directory, "transcript.jsonl"), " ".repeat(8 * 1024 * 1024 + 1));
  expect(f.store.review(f.sessionId).records[0].canResolve).toBe(false);
  f.state.costState = new UsageLedger({ namespace: "other" }).sessionState(f.sessionId, f.root);
  f.save();
  expect(() => f.store.review(f.sessionId)).toThrow("incarnation");
});

test("SDK operation ownership uses the Engine's trusted custom UsageLedger, while Desktop default review rejects it", async () => {
  const f = fixture();
  const usageLedger = new UsageLedger({ namespace: "sdk-owner" });
  f.state.costState = usageLedger.sessionState(f.sessionId, f.root);
  f.save();
  expect(() => f.store.review(f.sessionId)).toThrow("incarnation");
  let sends = 0;
  const controller = createSessionOperationController(f.root, f.sessionId, usageLedger);
  const result = await controller.run(f.plan, {
    assertAuthorized() {},
    preflight: async () => {},
    validate: async () => {},
    authorize: async () => true,
    execute: async () => {
      sends++;
      return { id: "123" };
    },
    verify: async () => true,
  });
  expect(result.state).toBe("verified");
  expect(sends).toBe(1);
});
