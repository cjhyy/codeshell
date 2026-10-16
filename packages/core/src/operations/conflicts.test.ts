import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { OperationLedger, type OperationPlan } from "./ledger.js";
import { PlaintextCipher } from "../credentials/cipher.js";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "link-conflicts-"));
  roots.push(root);
  return { root, file: join(root, ".operations/ledger.json"), ledger: new OperationLedger(root) };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const plan = (sessionId: string, overrides: Partial<OperationPlan> = {}): OperationPlan => ({
  sessionId,
  intentId: `intent-${sessionId}`,
  service: "github",
  action: "create_issue",
  channel: "link",
  account: { id: "PRIVATE_ACCOUNT", connectionId: `connection-${sessionId}` },
  target: { owner: "PRIVATE_OWNER", repo: "PRIVATE_REPO" },
  parameters: { body: "PRIVATE_BODY" },
  postcondition: { kind: "matches" },
  ...overrides,
});

for (const state of ["running", "succeeded", "unknown"] as const) {
  test(`cross-Session replacement connection cannot bypass ${state} write`, () => {
    const f = fixture();
    const one = f.ledger.prepare(plan("one"));
    const claim = f.ledger.claim(one.id);
    expect(claim.claimed).toBe(true);
    if (state !== "running")
      f.ledger.settle(
        one.id,
        claim.receipt.attemptId,
        state,
        state === "succeeded" ? { reference: { id: "42" } } : {},
      );
    const cold = new OperationLedger(f.root);
    const two = cold.prepare(plan("two"));
    expect(cold.claim(two.id)).toMatchObject({
      claimed: false,
      receipt: { state: "blocked", error: "stale_reference" },
    });
    const bytes = readFileSync(f.file, "utf8");
    for (const secret of [
      "PRIVATE_ACCOUNT",
      "PRIVATE_OWNER",
      "PRIVATE_REPO",
      "PRIVATE_BODY",
      "connection-one",
    ])
      expect(bytes).not.toContain(secret);
  });
}

test("known account/instance/target differences do not block unrelated writes; missing account is wildcard", () => {
  for (const variation of ["account", "instance", "target", "missing-account"] as const) {
    const f = fixture();
    const scope = {
      instance: "https://private.example",
      account: "PRIVATE_ACCOUNT",
      target: { repo: 42 },
    };
    const one = f.ledger.prepare(
      plan("one", {
        conflictScope: { ...scope, ...(variation === "missing-account" ? { account: null } : {}) },
      }),
    );
    expect(f.ledger.claim(one.id).claimed).toBe(true);
    const nextScope = {
      ...scope,
      ...(variation === "account" || variation === "missing-account"
        ? { account: "different" }
        : {}),
      ...(variation === "instance" ? { instance: "https://different.example" } : {}),
      ...(variation === "target" ? { target: { repo: 99 } } : {}),
    };
    const next = f.ledger.prepare(plan("two", { conflictScope: nextScope }));
    expect(f.ledger.claim(next.id).claimed).toBe(variation !== "missing-account");
  }
});

test("legacy recovery builds conflict proof independent of removed connection; no recovery fences only provider", () => {
  for (const recovery of [true, false]) {
    const f = fixture();
    const p = plan("old");
    const old = f.ledger.prepare(p);
    if (recovery) f.ledger.captureRecovery(p, old.id, "prepared", { original: true });
    f.ledger.claim(old.id);
    const raw = JSON.parse(readFileSync(f.file, "utf8"));
    delete raw.records[old.id].conflictScope;
    writeFileSync(f.file, JSON.stringify(raw));
    const cold = new OperationLedger(f.root);
    expect(cold.protectUnresolvedWrites("github")).toBe(1);
    const persisted = JSON.parse(readFileSync(f.file, "utf8")).records[old.id].conflictScope;
    expect(Object.keys(persisted).sort()).toEqual(recovery ? ["account", "target"] : []);
    const different = cold.prepare(
      plan("new", { account: { id: "different" }, target: { repo: "other" } }),
    );
    expect(cold.claim(different.id).claimed).toBe(recovery);
    const unrelated = cold.prepare(plan("other-provider", { service: "gitlab" }));
    expect(cold.claim(unrelated.id).claimed).toBe(true);
  }
});

test("offline cleanup with unavailable ledger key persists a provider barrier without touching encrypted evidence", () => {
  const f = fixture();
  const old = f.ledger.prepare(plan("old"));
  f.ledger.claim(old.id);
  const raw = JSON.parse(readFileSync(f.file, "utf8"));
  delete raw.records[old.id].conflictScope;
  raw.key = "enc:fixture:PRIVATE_ENCRYPTED_KEY";
  writeFileSync(f.file, JSON.stringify(raw));
  expect(new OperationLedger(f.root, new PlaintextCipher()).protectUnresolvedWrites("github")).toBe(
    1,
  );
  const saved = JSON.parse(readFileSync(f.file, "utf8"));
  expect(saved.key).toBe(raw.key);
  expect(saved.records[old.id].conflictScope).toEqual({});
  expect(saved.records[old.id].attemptId).toBe(raw.records[old.id].attemptId);
});

test("verified writes release cross-session conflict", () => {
  const f = fixture();
  const old = f.ledger.prepare(plan("old"));
  const claim = f.ledger.claim(old.id);
  f.ledger.settle(old.id, claim.receipt.attemptId, "succeeded", { reference: { id: "42" } });
  f.ledger.settle(old.id, claim.receipt.attemptId, "verified");
  const next = f.ledger.prepare(plan("next"));
  expect(f.ledger.claim(next.id).claimed).toBe(true);
});

test("two processes cannot both claim the same resource under different sessions", async () => {
  const f = fixture();
  const first = f.ledger.prepare(plan("one"));
  const second = f.ledger.prepare(plan("two"));
  const module = new URL("./ledger.ts", import.meta.url).href;
  const code = `import { OperationLedger } from ${JSON.stringify(module)}; process.stdout.write(JSON.stringify(new OperationLedger(process.argv[1]).claim(process.argv[2]).claimed));`;
  const run = (id: string) =>
    new Promise<boolean>((resolve, reject) => {
      const child = spawn(process.execPath, ["--eval", code, f.root, id], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.on("error", reject);
      child.on("exit", (status) =>
        status === 0 ? resolve(JSON.parse(output)) : reject(new Error("claim child failed")),
      );
    });
  expect((await Promise.all([run(first.id), run(second.id)])).filter(Boolean)).toHaveLength(1);
});
