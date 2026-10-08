import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstructionBindingStore, instructionHash } from "./instruction-bindings.js";
import { readSkillSnapshot } from "./snapshot.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "binding-store-"));
  roots.push(cwd);
  const file = join(cwd, ".code-shell", "skills", "test-binding", "SKILL.md");
  mkdirSync(join(cwd, ".code-shell", "skills", "test-binding"), { recursive: true });
  const source = "---\nname: test-binding\ndescription: Fixture\n---\nOriginal instructions";
  writeFileSync(file, source);
  const sourceRevision = readSkillSnapshot("test-binding", cwd)!.revision;
  const store = new InstructionBindingStore(join(cwd, "bindings"));
  const id = randomUUID();
  mkdirSync(join(store.root, "receipts"), { recursive: true });
  const receiptFile = join(store.root, "receipts", `${id}.json`);
  writeFileSync(
    receiptFile,
    JSON.stringify({
      id,
      cwd,
      provider: "openai",
      model: "fixture",
      name: "test-binding",
      sourceRevision,
      bodyHash: instructionHash("Accepted instructions"),
      sessionId: "isolated-fixture",
      completed: true,
    }),
  );
  const input = {
    scope: { cwd, provider: "openai", model: "fixture" },
    name: "test-binding",
    sourceRevision,
    body: "Accepted instructions",
    evidenceHash: "a".repeat(64),
    receiptIds: [id],
  };
  return { cwd, file, source, store, input, receiptFile };
}
test("binding store freezes exact host content and scopes project, Session and model", () => {
  const f = fixture();
  const binding = f.store.adopt(f.input);
  expect(f.store.adopt(f.input)).toEqual(binding);
  expect(f.store.resolve(f.input.scope)).toEqual([binding.snapshot]);
  expect(f.store.resolve({ ...f.input.scope, model: "other" })).toEqual([]);
  const targeted = f.store.adopt({
    ...f.input,
    scope: { ...f.input.scope, sessionId: "selected" },
  });
  expect(f.store.resolve({ ...f.input.scope, sessionId: "selected" })).toEqual([targeted.snapshot]);
  expect(f.store.resolve({ ...f.input.scope, sessionId: "other" })).toEqual([binding.snapshot]);
  expect(f.store.isCurrent({ ...binding.snapshot, body: "Unexpected recovered content" })).toBe(
    false,
  );
  expect(readFileSync(f.file, "utf8")).toBe(f.source);
});
test("source revision changes invalidate recovered snapshots and reject new resolution", () => {
  const f = fixture();
  const binding = f.store.adopt(f.input);
  writeFileSync(f.file, f.source + "\nUser changed source");
  expect(f.store.isCurrent(binding.snapshot)).toBe(false);
  expect(() => f.store.resolve(f.input.scope)).toThrow("source Skill changed");
  expect(() => f.store.adopt(f.input)).toThrow("revision changed");
  expect(
    f.store.revoke(f.cwd, binding.snapshot.bindingId, binding.snapshot.revision).revokedAt,
  ).not.toBeNull();
  expect(readFileSync(f.file, "utf8")).toContain("User changed source");
});
test("receipt fields are strict and false/incomplete loading is not adoption evidence", () => {
  const f = fixture();
  const receipt = JSON.parse(readFileSync(f.receiptFile, "utf8"));
  writeFileSync(f.receiptFile, JSON.stringify({ ...receipt, completed: "true" }));
  expect(() => f.store.adopt(f.input)).toThrow();
  writeFileSync(f.receiptFile, JSON.stringify({ ...receipt, completed: false }));
  expect(() => f.store.adopt(f.input)).toThrow("does not match");
  expect(() => f.store.adopt({ ...f.input, receiptIds: [] })).toThrow("receipts are required");
});
test("revocation is idempotent, revision protected and synchronously notifies the owning subscriber", () => {
  const f = fixture();
  const binding = f.store.adopt(f.input);
  let revoked = 0;
  const dispose = f.store.provider().subscribe([binding.snapshot], () => {
    revoked++;
  });
  try {
    expect(() => f.store.revoke(f.cwd, binding.snapshot.bindingId, "b".repeat(64))).toThrow(
      "conflict",
    );
    f.store.revoke(f.cwd, binding.snapshot.bindingId, binding.snapshot.revision);
    f.store.revoke(f.cwd, binding.snapshot.bindingId, binding.snapshot.revision);
    expect(revoked).toBe(1);
    expect(f.store.resolve(f.input.scope)).toEqual([]);
  } finally {
    dispose();
  }
});
