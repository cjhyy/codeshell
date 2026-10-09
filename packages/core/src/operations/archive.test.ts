import { afterEach, expect, test } from "bun:test";
import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlaintextCipher } from "../credentials/cipher.js";
import { OperationController } from "./controller.js";
import { OperationLedger, type OperationPlan, type OperationReceipt } from "./ledger.js";
import { OperationRecoveryFiles } from "./recovery.js";
import { legacyStateSchema } from "./schema.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const plan = (intentId = "original"): OperationPlan => ({
  sessionId: "retention-session",
  intentId,
  service: "fixture",
  action: "write",
  channel: "link",
  account: "fixture-account",
  target: "fixture-target",
  parameters: { body: "private-original-input" },
  postcondition: { body: "private-original-input" },
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codeshell-retention-"));
  chmodSync(root, 0o700);
  roots.push(root);
  const file = join(root, ".operations", "ledger.json");
  const cipher = new PlaintextCipher();
  const ledger = new OperationLedger(root, cipher);
  const receipt = ledger.prepare(plan());
  const attempt = ledger.claim(receipt.id).receipt.attemptId!;
  ledger.settle(receipt.id, attempt, "succeeded", { reference: { id: "original/reference" } });
  const verified = ledger.settle(receipt.id, attempt, "verified");
  return { root, file, cipher, ledger, verified };
}
function seed(
  fixture: ReturnType<typeof fixture>,
  mutate?: (record: OperationReceipt, index: number) => void,
  count = 9000,
) {
  const state = JSON.parse(readFileSync(fixture.file, "utf8"));
  const key = Buffer.from(fixture.cipher.decrypt(state.key), "hex");
  for (let index = 1; index < count; index++) {
    const id = createHmac("sha256", key)
      .update(JSON.stringify(["intent", [plan().sessionId, `seed-${index}`, null]]))
      .digest("hex");
    const record = { ...fixture.verified, id, createdAt: fixture.verified.createdAt + index };
    mutate?.(record, index);
    state.records[id] = record;
  }
  writeFileSync(fixture.file, JSON.stringify(state), { mode: 0o600 });
  return state;
}
function archiveFile(fixture: ReturnType<typeof fixture>) {
  const state = JSON.parse(readFileSync(fixture.file, "utf8"));
  const prefix = fixture.verified.id.slice(0, 2);
  return join(
    fixture.root,
    ".operations",
    "archives",
    `${prefix}-${state.archives.buckets[prefix].digest}.json`,
  );
}
function hash(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("schema2 reclaims active capacity without changing the key, full receipt or cold intent", async () => {
  const f = fixture();
  const original = seed(f);
  f.ledger.prepare(plan("new-intent"));
  const current = JSON.parse(readFileSync(f.file, "utf8"));
  expect(current.schema).toBe(2);
  expect(current.key).toBe(original.key);
  expect(Object.keys(current.records).length).toBeLessThan(9000);
  expect(current.records[f.verified.id]).toBeUndefined();
  const cold = new OperationLedger(f.root, f.cipher);
  let sends = 0;
  const actual = await new OperationController(cold).run(plan(), {
    assertAuthorized() {},
    async preflight() {},
    async validate() {},
    async authorize() {
      return true;
    },
    async execute() {
      sends++;
      return { id: "never" };
    },
    async verify() {
      return true;
    },
  });
  expect(actual).toEqual(f.verified);
  expect(sends).toBe(0);
  expect(cold.provePlan(actual, plan())).toBe(true);
  expect(cold.claim(actual.id)).toEqual({ receipt: actual, claimed: false });
  expect(cold.settle(actual.id, actual.attemptId, "succeeded")).toEqual(actual);
  expect(cold.settle(actual.id, actual.attemptId, "verified")).toEqual(actual);
  expect(cold.sealPending(actual.id)).toEqual(actual);
  expect(() => cold.settle(actual.id, randomUUID(), "verified")).toThrow("attempt changed");
  expect(() => cold.settle(actual.id, actual.attemptId, "unknown")).toThrow("immutable");
  expect(() => cold.prepare({ ...plan(), target: "changed" })).toThrow("immutable plan");
  expect(() => legacyStateSchema.parse(current)).toThrow();
});

test("readonly lookup keeps manifest and orphan generations byte-for-byte unchanged", () => {
  const f = fixture();
  seed(f);
  f.ledger.prepare(plan("new-intent"));
  const directory = join(f.root, ".operations", "archives");
  const orphan = join(directory, `.stage-${randomUUID()}.tmp`);
  writeFileSync(orphan, "interrupted staging", { mode: 0o600 });
  const paths = [f.file, ...readdirSync(directory).map((name) => join(directory, name))];
  const before = paths.map((path) => [path, hash(path), statSync(path).mtimeMs]);
  const cold = new OperationLedger(f.root, f.cipher);
  expect(cold.prepare(plan())).toEqual(f.verified);
  expect(cold.provePlan(f.verified, plan())).toBe(true);
  expect(cold.hasUnverifiedWrites(plan().sessionId)).toBe(false);
  expect(cold.claim(f.verified.id).claimed).toBe(false);
  expect(paths.map((path) => [path, hash(path), statSync(path).mtimeMs])).toEqual(before);
  cold.prepare(plan("next-real-write"));
  expect(existsSync(orphan)).toBe(false);
});

test("unknowns, attempts, decisions and observations never enter cold buckets", () => {
  const f = fixture();
  const state = seed(f, (record, index) => {
    if (index === 1) record.state = "unknown";
    if (index === 2) record.state = "running";
    if (index === 3) record.state = "succeeded";
    if (index === 4) record.state = "failed";
    if (index === 5) record.state = "blocked"; // Has an attempt; not an unsent receipt.
    if (index === 6)
      record.operatorResolution = {
        id: randomUUID(),
        decision: "accept_uncertainty",
        at: 1,
        reviewedRevision: "a".repeat(64),
      };
  });
  state.observations = {
    [f.verified.id]: [
      {
        id: randomUUID(),
        at: 1,
        reviewedRevision: "a".repeat(64),
        ownerIncarnation: "b".repeat(64),
        result: "matches_current",
        actions: ["read"],
        evidence: "c".repeat(64),
      },
    ],
  };
  writeFileSync(f.file, JSON.stringify(state), { mode: 0o600 });
  f.ledger.prepare(plan("new"));
  const current = JSON.parse(readFileSync(f.file, "utf8"));
  for (const record of Object.values(state.records) as OperationReceipt[])
    if (record.id === f.verified.id || record.createdAt <= f.verified.createdAt + 6)
      expect(current.records[record.id]).toEqual(record);
  expect(current.observations).toEqual(state.observations);
  expect(f.ledger.hasUnverifiedWrites(plan().sessionId)).toBe(true);
  const claimed = f.ledger.claim(f.ledger.prepare(plan("barrier")).id);
  expect(claimed.claimed).toBe(false);
  expect(claimed.receipt.error).toBe("stale_reference");
});

test("all legal encrypted recovery slots including an orphan survive compaction and cold proof", () => {
  const f = fixture();
  const state = seed(f);
  const key = Buffer.from(f.cipher.decrypt(state.key), "hex");
  const files = new OperationRecoveryFiles(join(f.root, ".operations"));
  const prepared = files.save(key, f.verified.id, "original encrypted input");
  const orphan = files.save(key, f.verified.id, "failed checkpoint orphan");
  state.records[f.verified.id].recovery = { prepared };
  writeFileSync(f.file, JSON.stringify(state), { mode: 0o600 });
  f.ledger.prepare(plan("new"));
  const current = JSON.parse(readFileSync(f.file, "utf8"));
  const bucket = JSON.parse(readFileSync(archiveFile(f), "utf8"));
  const summary = bucket.recovery[f.verified.id];
  expect(summary.slots.map((slot: { digest: string }) => slot.digest).sort()).toEqual(
    [prepared, orphan].sort(),
  );
  expect(current.archives.buckets[f.verified.id.slice(0, 2)].recoveryBytes).toBe(summary.bytes);
  expect(files.read(key, f.verified.id, prepared)).toBe("original encrypted input");
  expect(files.read(key, f.verified.id, orphan)).toBe("failed checkpoint orphan");
  expect(new OperationLedger(f.root, f.cipher).prepare(plan()).recovery).toEqual({ prepared });
  rmSync(join(f.root, ".operations", "recovery", f.verified.id, `${orphan}.json`));
  expect(() => new OperationLedger(f.root, f.cipher).prepare(plan())).toThrow("recovery changed");
});

test("target prefix tamper, missing bucket, manifest forgery and symlinks fail closed", () => {
  for (const kind of ["tamper", "missing", "manifest", "symlink"]) {
    const f = fixture();
    seed(f);
    f.ledger.prepare(plan("new"));
    const target = archiveFile(f);
    if (kind === "tamper") {
      const text = readFileSync(target, "utf8");
      writeFileSync(target, text.replace("original/reference", "different/referenc"));
    } else if (kind === "missing") rmSync(target);
    else if (kind === "symlink") {
      const other = join(f.root, "other.json");
      writeFileSync(other, readFileSync(target), { mode: 0o600 });
      rmSync(target);
      symlinkSync(other, target);
    } else {
      const current = JSON.parse(readFileSync(f.file, "utf8"));
      current.archives.buckets[f.verified.id.slice(0, 2)].count++;
      writeFileSync(f.file, JSON.stringify(current), { mode: 0o600 });
    }
    const cold = new OperationLedger(f.root, f.cipher);
    expect(() => cold.prepare(plan())).toThrow();
    expect(() => cold.claim(f.verified.id)).toThrow();
    expect(() => cold.provePlan(f.verified, plan())).toThrow();
    expect(() => cold.settle(f.verified.id, f.verified.attemptId, "verified")).toThrow();
  }
});

test("missing ledger beside archive or recovery cannot mint a replacement key", () => {
  const f = fixture();
  seed(f);
  f.ledger.prepare(plan("new"));
  rmSync(f.file);
  const cold = new OperationLedger(f.root, f.cipher);
  expect(() => cold.prepare(plan())).toThrow("manifest is missing");
  expect(() => cold.hasUnverifiedWrites(plan().sessionId)).toThrow("manifest is missing");
  expect(existsSync(f.file)).toBe(false);
});

test("an archived unsent blocked intent is never reopened by a late callback", () => {
  const f = fixture();
  const state = seed(f);
  const blocked = { ...state.records[f.verified.id], state: "blocked", error: "cancelled" };
  delete blocked.attemptId;
  delete blocked.reference;
  delete blocked.verifiedAt;
  state.records[blocked.id] = blocked;
  writeFileSync(f.file, JSON.stringify(state), { mode: 0o600 });
  f.ledger.prepare(plan("new"));
  const cold = new OperationLedger(f.root, f.cipher);
  expect(cold.prepare(plan())).toEqual(blocked);
  expect(cold.claim(blocked.id)).toEqual({ receipt: blocked, claimed: false });
  expect(cold.sealPending(blocked.id)).toEqual(blocked);
  expect(() => cold.settle(blocked.id, undefined, "unknown")).toThrow("immutable");
  expect(() => cold.settle(blocked.id, undefined, "blocked")).toThrow("immutable");
});

test("a full unsafe ledger fails before authorization or execution and never migrates", async () => {
  const f = fixture();
  const state = seed(
    f,
    (record) => {
      record.state = "unknown";
    },
    10_000,
  );
  state.records[f.verified.id].state = "unknown";
  writeFileSync(f.file, JSON.stringify(state), { mode: 0o600 });
  const before = hash(f.file);
  let calls = 0;
  await expect(
    new OperationController(f.ledger).run(plan("new"), {
      assertAuthorized() {
        calls++;
      },
      async preflight() {
        calls++;
      },
      async validate() {
        calls++;
      },
      async authorize() {
        calls++;
        return true;
      },
      async execute() {
        calls++;
        return { id: "never" };
      },
      async verify() {
        calls++;
        return true;
      },
    }),
  ).rejects.toThrow("ledger is full");
  expect(calls).toBe(0);
  expect(hash(f.file)).toBe(before);
  expect(existsSync(join(f.root, ".operations", "archives"))).toBe(false);
});

test("missing original recovery and unexpected staging entries refuse real writes", () => {
  const f = fixture();
  const state = seed(f);
  state.records[f.verified.id].recovery = { prepared: "a".repeat(64) };
  writeFileSync(f.file, JSON.stringify(state), { mode: 0o600 });
  const before = hash(f.file);
  expect(() => f.ledger.prepare(plan("new"))).toThrow();
  expect(hash(f.file)).toBe(before);
  delete state.records[f.verified.id].recovery;
  writeFileSync(f.file, JSON.stringify(state), { mode: 0o600 });
  const unrelated = join(f.root, ".operations", "unexpected");
  writeFileSync(unrelated, "preserve me", { mode: 0o600 });
  expect(() => f.ledger.prepare(plan("new"))).toThrow("staging directory entry");
  expect(readFileSync(unrelated, "utf8")).toBe("preserve me");
});

test("a rolled-back manifest cannot discard later immutable dedup evidence or send an old intent", async () => {
  for (const missing of [false, true]) {
    const f = fixture();
    const backup = seed(f);
    f.ledger.prepare(plan("new"));
    const archived = archiveFile(f);
    const archiveBefore = hash(archived);
    if (missing) delete backup.records[f.verified.id];
    else {
      backup.records[f.verified.id].state = "planned";
      delete backup.records[f.verified.id].attemptId;
      delete backup.records[f.verified.id].reference;
      delete backup.records[f.verified.id].verifiedAt;
    }
    writeFileSync(f.file, JSON.stringify(backup), { mode: 0o600 });
    const before = hash(f.file);
    let sends = 0;
    await expect(
      new OperationController(new OperationLedger(f.root, f.cipher)).run(plan(), {
        assertAuthorized() {},
        async preflight() {},
        async validate() {},
        async authorize() {
          return true;
        },
        async execute() {
          sends++;
          return { id: "never" };
        },
        async verify() {
          return true;
        },
      }),
    ).rejects.toThrow("not covered");
    expect(sends).toBe(0);
    expect(hash(archived)).toBe(archiveBefore);
    expect(hash(f.file)).toBe(before);
  }
});

test("unreferenced immutable corruption and excessive staging refuse GC without deleting evidence", () => {
  const f = fixture();
  seed(f);
  f.ledger.prepare(plan("new"));
  const directory = join(f.root, ".operations", "archives");
  const orphan = join(directory, `ff-${"a".repeat(64)}.json`);
  writeFileSync(orphan, "corrupt immutable evidence", { mode: 0o600 });
  const before = hash(f.file);
  expect(() => f.ledger.prepare(plan("refuse-corrupt-gc"))).toThrow("authentication");
  expect(readFileSync(orphan, "utf8")).toBe("corrupt immutable evidence");
  expect(hash(f.file)).toBe(before);
  rmSync(orphan);
  const stages = Array.from({ length: 3 }, () => join(directory, `.stage-${randomUUID()}.tmp`));
  for (const stage of stages) writeFileSync(stage, "partial stage", { mode: 0o600 });
  expect(() => f.ledger.prepare(plan("refuse-stage-gc"))).toThrow("orphan capacity");
  for (const stage of stages) expect(existsSync(stage)).toBe(true);
  expect(hash(f.file)).toBe(before);
});
