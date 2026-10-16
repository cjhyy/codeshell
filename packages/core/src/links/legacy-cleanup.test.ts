import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore } from "../credentials/store.js";
import { PlaintextCipher, type EncryptionCipher } from "../credentials/cipher.js";
import type { Credential } from "../credentials/types.js";
import { OperationLedger, type OperationPlan } from "../operations/ledger.js";
import { cleanupLegacyLinkConnections, previewLegacyLinkCleanup } from "./legacy-cleanup.js";
import { allowsLinkAction } from "./authority.js";

const roots: string[] = [];
function fixture(cipher: EncryptionCipher = new PlaintextCipher()) {
  const root = mkdtempSync(join(tmpdir(), "legacy-link-cleanup-"));
  roots.push(root);
  return {
    root,
    store: new CredentialStore(root, cipher, join(root, "user")),
    operations: join(root, "operations"),
    user: join(root, "user/credentials.json"),
  };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const local = (id = "old-local"): Credential => ({
  id,
  type: "link",
  label: "PRIVATE_LABEL",
  secret: "PRIVATE_TOKEN",
  meta: {
    linkProvider: "github",
    linkConnectionMethod: "fine-grained-pat",
    linkExecutionRuntime: "local",
    linkExecutionBackend: "http-token",
    agentExposable: false,
    linkAccountId: "PRIVATE_ACCOUNT",
  },
});
const remote = (id = "old-remote"): Credential => ({
  id,
  type: "oauth",
  label: "remote",
  secret: JSON.stringify({
    accessToken: `ACCESS-${id}`,
    refreshToken: `REFRESH-${id}`,
    clientId: "client",
    issuer: "https://fixture.invalid",
  }),
  meta: {
    linkProvider: "github",
    linkConnectionMethod: "remote-link",
    linkExecutionRuntime: "server",
    linkExecutionBackend: "remote",
    agentExposable: false,
    linkRemoteIssuer: "https://fixture.invalid",
    linkRemoteGrantId: `grant-${id}`,
    linkRemoteState: "connected",
  },
});

test("cleanup removes only explicit old Link records in both layers and preserves private retirement custody", () => {
  const f = fixture();
  f.store.save("user", local());
  f.store.save("project", local()); // same id must not hide the user record
  f.store.save("user", remote());
  f.store.save("user", { id: "model", type: "token", label: "model", secret: "MODEL" });
  f.store.save("user", {
    id: "mcp",
    type: "oauth",
    label: "MCP",
    secret: "MCP",
    meta: { mcpServerName: "figma" },
  });
  f.store.save("user", {
    ...local("new-model"),
    meta: { ...local().meta, recordSchemaVersion: 2 } as Credential["meta"],
  });
  f.store.stageRemoteLinkRetirement(remote("already-retired"), 0);
  writeFileSync(join(f.root, "project-document.txt"), "KEEP");
  const preview = previewLegacyLinkCleanup(f.store, "full");
  expect(preview).toHaveLength(3);
  expect(JSON.stringify(preview)).not.toContain("PRIVATE");
  let fenced = false;
  const result = cleanupLegacyLinkConnections({
    store: f.store,
    scope: "full",
    operationRoots: [f.operations],
    onDisabled: () => {
      fenced = true;
      for (const item of preview) {
        const c = f.store
          .listLayerWithStatus(item.scope)
          .credentials.find((record) => record.id === item.id)!;
        expect(c.meta?.linkCleanupDisabled).toBe(true);
        expect(allowsLinkAction({ ...c, hasSecret: true }, "github", "create_issue")).toBe(false);
      }
    },
  });
  expect(fenced).toBe(true);
  expect(result.removed).toHaveLength(3);
  expect(result.changed).toEqual([]);
  expect(result.remoteCleanupPending).toBe(2);
  expect(
    f.store
      .list("full")
      .map((c) => c.id)
      .sort(),
  ).toEqual(["mcp", "model", "new-model"]);
  expect(readFileSync(join(f.root, "project-document.txt"), "utf8")).toBe("KEEP");
  expect(f.store.claimRemoteLinkRetirement(Date.now())?.credential.meta?.linkRemoteGrantId).toBe(
    "grant-already-retired",
  );
});

test("unknown write barrier survives direct deletion and new connection/session", () => {
  const f = fixture();
  f.store.save("user", local());
  const ledger = new OperationLedger(f.operations);
  const plan: OperationPlan = {
    sessionId: "old-session",
    intentId: "old-intent",
    service: "github",
    action: "create_issue",
    channel: "link",
    account: { id: null, connectionId: "old-local" },
    target: { repo: "repo" },
    parameters: {},
    postcondition: {},
  };
  const receipt = ledger.prepare(plan);
  const claim = ledger.claim(receipt.id);
  ledger.settle(receipt.id, claim.receipt.attemptId, "unknown");
  cleanupLegacyLinkConnections({ store: f.store, scope: "full", operationRoots: [f.operations] });
  expect(f.store.resolve("old-local")).toBeUndefined();
  const cold = new OperationLedger(f.operations);
  const next = cold.prepare({
    ...plan,
    sessionId: "new-session",
    intentId: "new-intent",
    account: { id: "other", connectionId: "new-id" },
  });
  expect(cold.claim(next.id).claimed).toBe(false);
  expect(
    JSON.parse(readFileSync(join(f.operations, ".operations/ledger.json"), "utf8")).records[
      receipt.id
    ].state,
  ).toBe("unknown");
});

test("unreadable layers and missing operation roots fail without deleting credentials", () => {
  const f = fixture();
  f.store.save("user", local());
  expect(() =>
    cleanupLegacyLinkConnections({ store: f.store, scope: "full", operationRoots: [] }),
  ).toThrow();
  expect(f.store.resolve("old-local")).toBeDefined();
  writeFileSync(f.user, "not-json");
  expect(() => previewLegacyLinkCleanup(f.store, "full")).toThrow();
  expect(readFileSync(f.user, "utf8")).toBe("not-json");
});

test("CAS change after disable never deletes a replacement connection", () => {
  const f = fixture();
  f.store.save("user", local());
  const result = cleanupLegacyLinkConnections({
    store: f.store,
    scope: "full",
    operationRoots: [f.operations],
    onDisabled: () => f.store.save("user", { ...local(), secret: "NEW_TOKEN" }),
  });
  expect(result.removed).toHaveLength(0);
  expect(result.changed).toHaveLength(1);
  expect(f.store.resolve("old-local")?.secret).toBe("NEW_TOKEN");
});

test("offline removal preserves encrypted remote tokens for a later Host with the original cipher", () => {
  const cipher: EncryptionCipher = {
    encrypt: (value) => `enc:fixture:${Buffer.from(value).toString("base64")}`,
    decrypt: (value) =>
      value.startsWith("enc:fixture:")
        ? Buffer.from(value.slice(12), "base64").toString()
        : value.startsWith("plain:")
          ? value.slice(6)
          : value,
    canDecrypt: (value) => !value.startsWith("enc:") || value.startsWith("enc:fixture:"),
  };
  const f = fixture(cipher);
  f.store.save("user", remote());
  const offline = new CredentialStore(f.root, new PlaintextCipher(), join(f.root, "user"));
  const result = cleanupLegacyLinkConnections({
    store: offline,
    scope: "full",
    operationRoots: [f.operations],
  });
  expect(result.removed).toHaveLength(1);
  expect(offline.claimRemoteLinkRetirement(Date.now())).toBeUndefined();
  const restored = new CredentialStore(f.root, cipher, join(f.root, "user"));
  expect(restored.claimRemoteLinkRetirement(Date.now())?.credential.secret).toBe(remote().secret);
});
