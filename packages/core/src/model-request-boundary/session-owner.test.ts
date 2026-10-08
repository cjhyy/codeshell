import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDurableRequestOwner } from "./session-owner.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
test("durable owner pin must match persisted SID, storage scope and incarnation", () => {
  const root = mkdtempSync(join(tmpdir(), "codeshell-proof-owner-"));
  directories.push(root);
  const storage = join(root, "sessions");
  const subject = {
    sessionId: "same-sid",
    storageScopeId: createHash("sha256").update(storage).digest("hex"),
    sessionInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  };
  const state = {
    sessionId: subject.sessionId,
    costState: {
      accountingSessionId: subject.sessionInstanceId,
      sessionScopeId: subject.storageScopeId,
    },
  };
  const directory = join(storage, subject.sessionId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "state.json"), JSON.stringify(state), { mode: 0o600 });
  expect(() => assertDurableRequestOwner(subject, storage)).not.toThrow();
  expect(() =>
    assertDurableRequestOwner(
      { ...subject, sessionInstanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      storage,
    ),
  ).toThrow();
  expect(() => assertDurableRequestOwner({ ...subject, ephemeral: true }, storage)).toThrow();
  const copied = join(root, "another-storage");
  mkdirSync(join(copied, subject.sessionId), { recursive: true, mode: 0o700 });
  writeFileSync(join(copied, subject.sessionId, "state.json"), JSON.stringify(state), {
    mode: 0o600,
  });
  expect(() => assertDurableRequestOwner(subject, copied)).toThrow();
  expect(() =>
    assertDurableRequestOwner(
      { ...subject, storageScopeId: createHash("sha256").update(copied).digest("hex") },
      copied,
    ),
  ).toThrow();
});
