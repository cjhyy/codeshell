import assert from "node:assert/strict";
import { createServer } from "node:http";
import http from "node:http";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installLocalNetworkGuard } from "../../../../../scripts/runtime-cost-smoke-isolation.mjs";

const root = process.argv[2]!;
let runtime:
  | Awaited<ReturnType<(typeof import("../runtime.js"))["createPanelRuntime"]>>
  | undefined;
const server = createServer((request, response) => {
  void (async () => {
    const current = runtime;
    if (!current) {
      response.writeHead(503).end();
      return;
    }
    if (await current.handleAssets(request, response)) return;
    if (await current.handle(request, response)) return;
    response.writeHead(404).end();
  })().catch((error) => response.writeHead(500).end(String(error)));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
installLocalNetworkGuard(origin);
assert.throws(() => fetch("https://scope.invalid/"), /non-fixture/);
assert.throws(() => http.get("http://127.0.0.1:9/"), /non-fixture/);
const { mock } = await import("bun:test");
const storage = await import("../storage-store.js");
const fs = await import("node:fs/promises");
const { renameSync: publishStorage } = await import("node:fs");
const { randomUUID } = await import("node:crypto");
const { runInNewContext } = await import("node:vm");
const { default: ts } = await import("typescript");
const storageSource = readFileSync(new URL("../storage-store.ts", import.meta.url), "utf8");
const parsedStorage = ts.createSourceFile(
  "storage.ts",
  storageSource,
  ts.ScriptTarget.Latest,
  true,
);
const writer = parsedStorage.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "writePanelAppStorage",
)!;
const compiledWriter = ts.transpileModule(writer.getText(parsedStorage).replace(/^export /, ""), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
let pauseStorage: (() => Promise<void>) | undefined;
const originalStorageWriter = storage.writePanelAppStorage;
mock.module("../storage-store.js", () => ({
  ...storage,
  writePanelAppStorage: (...args: Parameters<typeof originalStorageWriter>) => {
    if (!pauseStorage) return originalStorageWriter(...args);
    let prepares = 0;
    return runInNewContext(`${compiledWriter}\nwritePanelAppStorage`, {
      ...fs,
      renameSync: publishStorage,
      randomUUID,
      Buffer,
      process,
      panelAppStorageQuotaBytes: storage.panelAppStorageQuotaBytes,
      MAX_PANEL_APP_STORAGE_KEYS: 10_000,
      STORAGE_KEY_PATTERN: /^[a-zA-Z0-9._-]{1,80}$/,
      preparePanelAppStorage: async (file: string) => {
        await storage.preparePanelAppStorage(file);
        if (++prepares === 2) await pauseStorage?.();
      },
    })(...args);
  },
}));
const { createPanelRuntime } = await import("../runtime.js");
const { capturePanelProjectScope } = await import("../project-scope.js");
const cwd = join(root, "project");
const installed = join(root, "installed");
mkdirSync(cwd);
mkdirSync(join(installed, "app"), { recursive: true });
writeFileSync(
  join(installed, "app/index.html"),
  "<!doctype html><html><body>fixture</body></html>",
);
const revision = "a".repeat(64);
let captures = 0;
let binding = await capturePanelProjectScope({
  environmentDir: join(root, "environment"),
  projectPath: cwd,
  cwd,
  assertAuthority() {},
});
function create(permissions: string[]) {
  const app = {
    id: "scope-panel",
    version: "1",
    packageDigest: "b".repeat(64),
    title: { default: "Scope" },
    entry: "app/index.html",
    icon: "panel",
    singleton: true,
    permissions,
    installPath: installed,
    installedAt: new Date().toISOString(),
    source: { kind: "local", path: installed },
  };
  return createPanelRuntime({
    cwd,
    dataDir: join(root, "data"),
    host: "hub",
    projectScope: async () => {
      captures++;
      return binding;
    },
    ownerId: async () => "owner",
    isAuthorized: async () => true,
    listInstalled: async () => [app as never],
    snapshot: async () => ({
      workspace: cwd,
      hasProject: true,
      panels: [
        {
          ...app,
          revision,
          bound: true,
          enabled: true,
          globalDisabled: false,
          updatable: false,
          source: { kind: "local", label: "fixture" },
          compatibility: { supported: true, reasons: [] },
        } as never,
      ],
    }),
  });
}
const request = (path: string, value: unknown) =>
  fetch(origin + "/api/v1/panels/runtime/" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(value),
  });
async function prepare() {
  const response = await request("prepare", {
    appId: "scope-panel",
    revision,
    sessionId: "session-1234",
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json() as Promise<{ instanceId: string; context: Record<string, unknown> }>;
}
try {
  runtime = create(["storage"]);
  const without = await prepare();
  assert.equal(captures, 0);
  assert.equal(without.context.projectScope, undefined);
  assert.equal(without.context.cwd, undefined);
  await runtime.close();
  runtime = create(["context.workspace"]);
  const grant = await prepare();
  assert.deepEqual(grant.context.projectScope, binding.scope);
  assert.equal(captures, 1);
  const call = `${grant.instanceId}/call`;
  const context = await request(call, { method: "context.get" });
  assert.equal(context.status, 200);
  assert.deepEqual(
    ((await context.json()) as { projectScope: unknown }).projectScope,
    binding.scope,
  );
  assert.equal((await request(call, { method: "storage.get", params: { key: "x" } })).status, 403);
  assert.equal(
    (await request("prepare", { appId: "scope-panel", revision, projectScope: binding.scope }))
      .status,
    400,
  );
  assert.equal(
    (await request(call, { method: "context.get", projectScope: binding.scope })).status,
    400,
  );
  renameSync(cwd, cwd + "-old");
  mkdirSync(cwd);
  assert.equal((await request(call, { method: "context.get" })).status, 410);
  assert.equal((await request(call, { method: "storage.get", params: { key: "x" } })).status, 410);
  await runtime.close();
  binding = await capturePanelProjectScope({
    environmentDir: join(root, "environment"),
    projectPath: cwd,
    cwd,
    assertAuthority() {},
  });
  runtime = create(["context.workspace", "storage"]);
  const stored = await prepare();
  const storageCall = `${stored.instanceId}/call`;
  assert.equal(
    (
      await request(storageCall, {
        method: "storage.set",
        params: { key: "value", value: "first" },
      })
    ).status,
    200,
  );
  let entered!: () => void;
  let release!: () => void;
  const staged = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  pauseStorage = async () => {
    entered();
    await blocked;
  };
  const pendingStorage = request(storageCall, {
    method: "storage.set",
    params: { key: "value", value: "revoked" },
  });
  await staged;
  renameSync(cwd, cwd + "-second-old");
  mkdirSync(cwd);
  release();
  assert.ok((await pendingStorage).status >= 400);
  assert.deepEqual(
    JSON.parse(
      readFileSync(storage.panelAppStoragePath(join(root, "data"), "scope-panel", cwd), "utf8"),
    ),
    { value: "first" },
  );
  console.log(
    JSON.stringify({
      sourceOnly: true,
      guardedNetworkProbes: 2,
      workspacePermission: true,
      forgedIdentityRejected: true,
      noAdditionalAuthority: true,
      contextRevalidation: true,
      mountReplacementRevokesGrant: true,
      finalStorageFence: true,
    }),
  );
} finally {
  await runtime?.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
