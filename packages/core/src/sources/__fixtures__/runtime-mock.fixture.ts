import assert from "node:assert/strict";
import childProcess from "node:child_process";
import dns from "node:dns";
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { join } from "node:path";
import tls from "node:tls";

// This child receives a private HOME and an explicit environment. Deny network,
// DNS and descendants before importing any Core module.
const deny = () => {
  throw new Error("Source runtime fixture denied network or descendants");
};
globalThis.fetch = deny;
http.get = http.request = https.get = https.request = deny;
net.connect = net.createConnection = net.Socket.prototype.connect = tls.connect = deny;
Object.assign(dns, { lookup: deny, resolve: deny, resolve4: deny, resolve6: deny });
Object.assign(dns.promises, { lookup: deny, resolve: deny });
Object.assign(childProcess, {
  spawn: deny,
  spawnSync: deny,
  exec: deny,
  execSync: deny,
  execFile: deny,
  execFileSync: deny,
  fork: deny,
});
syncBuiltinESMExports();
assert.throws(() => http.get("http://127.0.0.1:9"), /fixture denied/);
assert.throws(() => dns.lookup("example.invalid", () => {}), /fixture denied/);

const { SettingsManager } = await import("../../settings/manager.js");
const { connectorAdapterFor, registerConnectorAdapter } = await import("../adapter.js");
const { bindSource } = await import("../binding.js");
const { saveSourceDefinition } = await import("../catalog.js");
const { buildSourcesContextSummary } = await import("../context-summary.js");
const { resolveEffectiveSourceAccess } = await import("../resolve.js");
const { listSourcesTool, readSourceTool, registerBuiltinSourceAdapters } =
  await import("../../tool-system/builtin/sources.js");

const isTest = process.env.NODE_ENV === "test";
assert.equal(connectorAdapterFor("mock") !== undefined, isTest);
registerBuiltinSourceAdapters();
assert.equal(connectorAdapterFor("mock") !== undefined, isTest);
for (const kind of ["local-files", "mcp-resource", "link", "collection"])
  assert.ok(connectorAdapterFor(kind), `${kind} still registers`);

const cwd = process.cwd();
const settings = new SettingsManager(cwd, "project");
const context = { cwd } as Parameters<typeof listSourcesTool>[1];
const resolve = (profile?: Parameters<typeof resolveEffectiveSourceAccess>[0]["profile"]) =>
  resolveEffectiveSourceAccess({ cwd, settings, credentialStatus: () => "ok", profile });
const summary = () => buildSourcesContextSummary({ cwd, settings });

saveSourceDefinition({
  id: "legacy-demo",
  label: "Legacy demo",
  kind: "mock",
  adapterConfig: {},
  enabled: true,
});
bindSource(settings, cwd, { sourceId: "legacy-demo", scopes: ["alpha"], readPolicy: "ask" });

if (isTest) {
  assert.ok(resolve().some((source) => source.sourceId === "legacy-demo"));
  assert.match(await listSourcesTool({}, context), /Legacy demo/);
  assert.match(summary(), /Legacy demo/);
  assert.match(
    await readSourceTool(
      { source: "legacy-demo", scope: "alpha", resource: "alpha/doc-1" },
      context,
    ),
    /alpha doc one 内容/,
  );
} else {
  // A legacy demo binding alone must not invent an empty project-files source.
  assert.deepEqual(resolve(), []);
  assert.equal(await listSourcesTool({}, context), "No data sources are bound to this workspace.");
  assert.equal(summary(), "");
  assert.match(
    await readSourceTool(
      { source: "legacy-demo", scope: "alpha", resource: "alpha/doc-1" },
      context,
    ),
    /source "legacy-demo" is not bound/,
  );
  // Even an explicitly registered adapter cannot restore production authority.
  const { mockAdapter } = await import("../adapters/mock.js");
  registerConnectorAdapter(mockAdapter);
  assert.deepEqual(resolve(), []);
  assert.match(
    await readSourceTool(
      { source: "legacy-demo", scope: "alpha", resource: "alpha/doc-1" },
      context,
    ),
    /source "legacy-demo" is not bound/,
  );
}

// Files remain usable when the only explicit binding was a historical demo.
const uploads = join(cwd, ".code-shell", "uploads");
mkdirSync(uploads, { recursive: true });
writeFileSync(join(uploads, "brief.md"), "real uploaded material");
assert.ok(resolve().some((source) => source.sourceId === "project-uploads"));
assert.match(await listSourcesTool({}, context), /brief\.md/);
assert.match(
  await readSourceTool(
    { source: "project-uploads", scope: "uploads", resource: "brief.md" },
    context,
  ),
  /real uploaded material/,
);
assert.deepEqual(resolve({ name: "blocked", sourceAccess: [] }), []);
assert.deepEqual(
  resolve({
    name: "demo-only",
    sourceAccess: [{ sourceId: "legacy-demo", scopes: ["alpha"], readPolicy: "ask" }],
  }).map((source) => source.sourceId),
  isTest ? ["legacy-demo"] : [],
);

// Names never determine deletion or visibility: this real source contains "mock".
saveSourceDefinition({
  id: "mock-reports",
  label: "Mock-named real service",
  kind: "mcp-resource",
  adapterConfig: { server: "reports" },
  enabled: true,
});
registerConnectorAdapter({
  kind: "mcp-resource",
  async listScopes() {
    return [{ id: "reports", label: "Reports" }];
  },
  async listResources() {
    return [{ id: "report", name: "Report", scopeId: "reports" }];
  },
  async read() {
    return { resourceId: "report", text: "real service material", truncated: false };
  },
});
bindSource(settings, cwd, { sourceId: "mock-reports", scopes: ["reports"], readPolicy: "ask" });
bindSource(settings, cwd, { sourceId: "missing-real", scopes: ["reports"], readPolicy: "deny" });
assert.equal(resolve().find((source) => source.sourceId === "mock-reports")?.status, "ok");
assert.equal(resolve().find((source) => source.sourceId === "missing-real")?.status, "dangling");
const list = await listSourcesTool({}, context);
const dynamicContext = summary();
assert.match(list, /Mock-named real service/);
assert.match(list, /missing-real/);
assert.match(dynamicContext, /Mock-named real service/);
if (!isTest) {
  assert.doesNotMatch(list, /Legacy demo|legacy-demo/);
  assert.doesNotMatch(dynamicContext, /Legacy demo/);
}
assert.match(
  await readSourceTool({ source: "mock-reports", scope: "reports", resource: "report" }, context),
  /real service material/,
);
console.log(JSON.stringify({ mode: process.env.NODE_ENV ?? "unset", testFixturesEnabled: isTest }));
