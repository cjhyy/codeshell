import { OperationStorage } from "../packages/desktop/src/host/composition/operation-storage.js";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UsageLedger } from "../packages/core/src/cost-ledger/store.js";
import { OperationLedger } from "../packages/core/src/operations/ledger.js";
import { readOperationSessionOwner } from "../packages/core/src/operations/session-owner.js";
import { HostOperationReviews } from "../packages/desktop/src/main/desktop-host/operation-review.js";
import {
  HostPortAuthority,
  HostSessionAuthority,
} from "../packages/desktop/src/main/desktop-host/authority.js";
import type { DesktopHostIdentity } from "../packages/desktop/src/shared/desktop-host-protocol.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(pause?: Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "codeshell-host-operation-"));
  roots.push(root);
  const sessionId = "fixture",
    directory = join(root, sessionId);
  mkdirSync(directory);
  writeFileSync(
    join(directory, "state.json"),
    JSON.stringify({
      sessionId,
      startedAt: 1,
      status: "unverified_write",
      cwd: root,
      runId: "run",
      stateRevision: 3,
      privateFixture: "must not cross the pipe",
      costState: new UsageLedger({ storageDir: join(root, ".usage-ledger") }).sessionState(
        sessionId,
        root,
      ),
    }),
  );
  const vault = new Map<string, string>();
  const cipher = {
    encrypt(secret: string) {
      const wrapped = "enc:synthetic:wrapped";
      vault.set(wrapped, secret);
      return wrapped;
    },
    decrypt(wrapped: string) {
      const value = vault.get(wrapped);
      if (!value) throw new Error("unexpected key");
      return value;
    },
  };
  const ledger = new OperationLedger(root, cipher, {
    sessionId,
    read: () => readOperationSessionOwner(root, sessionId),
  });
  const plan = {
    sessionId,
    intentId: "intent",
    service: "github",
    action: "create_issue",
    channel: "link",
    account: "fixture",
    target: "fixture",
    parameters: { body: "fixture" },
    postcondition: { body: "fixture" },
  };
  const item = ledger.prepare(plan),
    claimed = ledger.claim(item.id).receipt;
  ledger.settle(item.id, claimed.attemptId!, "unknown");
  const identity: DesktopHostIdentity = {
    webContentsId: 1,
    frameGeneration: 1,
    frameToken: "fixture-frame",
    windowKind: "workbench",
  };
  const sessions = new HostSessionAuthority();
  const port = new HostPortAuthority(identity, sessions);
  let revision = "registry";
  const local = new OperationStorage(
    root,
    () => revision,
    () => root,
  );
  const wrapped = local.wrappedKey()!;
  const key = { wrapped, secret: cipher.decrypt(wrapped) };
  const grant = () => ({ permit: new Int32Array(new SharedArrayBuffer(4)), assertCurrent() {} });
  const host = new HostOperationReviews(
    {
      review: local.review.bind(local),
      resolve: async (req) => {
        if (pause) await pause;
        return local.resolve(req);
      },
    },
    () => revision,
    () => root,
  );
  const guard = () => port.captureHistoryRead(sessionId, false);
  const review = () =>
    host.run(
      "host/operationReview",
      identity,
      { sessionId, key, scope: { cwd: root, root, authority: revision } },
      guard,
      grant(),
    );
  const resolve = (token: string, id: string, version: string) =>
    host.run(
      "host/operationResolve",
      identity,
      { sessionId, token, id, key, revision: version },
      guard,
      grant(),
    );
  return {
    review,
    resolve,
    host,
    sessions,
    sessionId,
    port,
    change: () => {
      revision = "replacement";
    },
  };
}

test("a native decision resolves only the reviewed pending ledger receipt and is single use", async () => {
  const f = fixture(),
    review = await f.review();
  if (typeof review !== "object") throw new Error("missing review");
  expect(JSON.stringify(review)).not.toContain("must not cross the pipe");
  const row = review.snapshot.records[0]!;
  expect(await f.resolve(review.token, row.id, row.revision)).toBe(true);
  await expect(f.resolve(review.token, row.id, row.revision)).rejects.toThrow();
  const next = await f.review();
  if (typeof next !== "object") throw new Error("missing review");
  expect(next.snapshot.records.some((entry) => entry.id === row.id && entry.canResolve)).toBe(
    false,
  );
});
test.each(["owner", "delete", "document", "project"])(
  "a native decision rejects an invalidated %s during confirmation",
  async (change) => {
    const f = fixture(),
      review = await f.review();
    if (typeof review !== "object") throw new Error("missing review");
    const row = review.snapshot.records[0]!;
    if (change === "owner") {
      f.sessions.setOwner(f.sessionId, 2);
      f.sessions.setOwner(f.sessionId, null);
    }
    if (change === "delete") {
      f.sessions.setDeleting(f.sessionId, true);
      f.sessions.setDeleting(f.sessionId, false);
    }
    if (change === "document") f.port.revoke();
    if (change === "project") f.change();
    await expect(f.resolve(review.token, row.id, row.revision)).rejects.toThrow();
  },
);

test("owner loss while a storage write is queued revokes its mutex-time CAS", async () => {
  const gate = Promise.withResolvers<void>(),
    f = fixture(gate.promise),
    review = await f.review();
  if (typeof review !== "object") throw new Error("missing review");
  const row = review.snapshot.records[0]!;
  const pending = f.resolve(review.token, row.id, row.revision);
  f.sessions.setOwner(f.sessionId, 2);
  f.host.authorityChanged();
  gate.resolve();
  await expect(pending).rejects.toThrow("revoked");
  f.sessions.setOwner(f.sessionId, null);
  const again = await f.review();
  if (typeof again !== "object") throw new Error("missing review");
  expect(again.snapshot.records[0]?.canResolve).toBe(true);
});
