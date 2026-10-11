import { mock, spyOn } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { officeZip, textPdf, wordXml } from "./upload-documents.mjs";

const [root, directory] = process.argv.slice(2);
const home = realpathSync(process.env.HOME);
assert.ok(process.versions.bun);
assert.equal(home, realpathSync(join(directory, "isolation", "home")));
assert.equal(process.env.USERPROFILE, home);
assert.equal(process.env.CODE_SHELL_HOME, join(home, ".code-shell"));
assert.equal(process.env.CODE_SHELL_DATA_ROOT, undefined);
assert.equal(
  Object.keys(process.env).some((name) =>
    /API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PROVIDER_KEY|^(?:HTTPS?|ALL)_PROXY$/i.test(name),
  ),
  false,
);
const persist = (name, value) =>
  writeFileSync(join(directory, name), JSON.stringify(value, null, 2), { mode: 0o600 });

// Bun's syncBuiltinESMExports does not rebind these named exports. Retain all
// actual exports/constructors; only I/O functions become synchronous deny guards.
// This covers the enumerated JS APIs, not arbitrary Bun native calls or OS I/O.
const modules = await Promise.all(
  ["node:dns", "node:dns/promises", "node:net", "node:tls", "node:http", "node:https"].map(
    async (name) => [name, await import(name)],
  ),
);
const denied = [];
const checks = [];
const deny = (label) => () => {
  denied.push(label);
  throw new Error("Collection Main URL fixture denies " + label);
};
function guard(object, name, label) {
  assert.equal(typeof object[name], "function", label);
  const blocked = deny(label);
  object[name] = blocked;
  checks.push(() => {
    assert.equal(object[name], blocked, label + " binding");
    assert.throws(() => object[name](), /fixture denies/);
  });
  return blocked;
}
const dnsMethod = /^(?:lookup(?:Service)?|resolve\w*|reverse)$/;
for (const [name, actual] of modules) {
  const exports = { ...actual };
  const methods = name.startsWith("node:dns")
    ? Object.keys(actual).filter((key) => dnsMethod.test(key) && typeof actual[key] === "function")
    : name === "node:net"
      ? ["connect", "createConnection"]
      : name === "node:tls"
        ? ["connect"]
        : ["request", "get"];
  for (const method of methods)
    exports[method] = guard(actual.default, method, name + "." + method);
  if (name.startsWith("node:dns")) {
    const prototype = actual.Resolver.prototype;
    for (const method of Object.getOwnPropertyNames(prototype).filter((key) => dnsMethod.test(key)))
      guard(prototype, method, name + ".Resolver." + method);
  }
  if (name === "node:net") guard(actual.Socket.prototype, "connect", "net.Socket.connect");
  if (name === "node:tls") guard(actual.TLSSocket.prototype, "connect", "tls.TLSSocket.connect");
  if (
    (name === "node:http" || name === "node:https") &&
    typeof actual.Agent.prototype.createConnection === "function"
  )
    guard(actual.Agent.prototype, "createConnection", name + ".Agent.createConnection");
  mock.module(name, () => ({ ...exports, default: actual.default }));
  const rebound = await import(name);
  for (const method of methods) {
    checks.push(() => {
      assert.equal(rebound[method], exports[method], name + " named " + method);
      assert.throws(() => rebound[method](), /fixture denies/);
    });
  }
}
// The callback module also exposes a promises object. Check its exact functions
// rather than assuming it aliases the separate promise module in every runtime.
const dns = await import("node:dns");
const promises = await import("node:dns/promises");
for (const method of Object.keys(promises).filter((key) => dnsMethod.test(key))) {
  if (dns.default.promises[method] !== promises[method])
    guard(dns.default.promises, method, "dns.promises." + method);
  else
    checks.push(() => {
      assert.equal(dns.default.promises[method], promises[method]);
      assert.throws(() => dns.default.promises[method](), /fixture denies/);
    });
}
guard(globalThis, "fetch", "fetch");
for (const check of checks) check();
assert.equal(denied.length, checks.length);
const expectedProbes = denied.length;
persist("before-core.json", {
  phase: "before-first-Core-import",
  pid: process.pid,
  ppid: process.ppid,
  bun: process.versions.bun,
  executable: realpathSync(process.execPath),
  home,
  negativeProbes: denied.length,
  expectedProbes,
  surfaces: denied,
});

const receipt = { valid: false, pid: process.pid, ppid: process.ppid, home };
let download;
try {
  const fromRoot = (path) => pathToFileURL(join(root, path)).href;
  const core = await import(fromRoot("packages/core/src/index.ts"));
  const internal = await import(fromRoot("packages/core/src/index.internal.ts"));
  const urlModule = await import(fromRoot("packages/core/src/sources/collection-url.ts"));
  const origin = "https://files.example";
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const bytes = officeZip({ "word/document.xml": wordXml("redirected Office document") });
  const pdf = textPdf();
  download = spyOn(urlModule, "downloadCollectionUrl")
    .mockResolvedValueOnce({
      bytes,
      proof: {
        requestedUrl: origin + "/download",
        finalUrl: origin + "/manual.docx",
        sizeBytes: bytes.length,
        sha256: digest(bytes),
        mimeType: "application/octet-stream",
      },
    })
    .mockResolvedValueOnce({
      bytes: pdf,
      proof: {
        requestedUrl: origin + "/download",
        finalUrl: origin + "/download",
        sizeBytes: pdf.length,
        sha256: digest(pdf),
        mimeType: "application/pdf",
      },
    });
  mock.module("@cjhyy/code-shell-core", () => core);
  mock.module("@cjhyy/code-shell-core/internal", () => ({
    ...internal,
    downloadCollectionUrl: download,
  }));
  // Desktop's tsconfig resolves package aliases to dist, while this fixture's
  // root tsconfig resolves them to source. Bind Main's actual resolved aliases.
  const mainDirectory = join(root, "packages/desktop/src/main");
  const mainCore = globalThis.Bun.resolveSync("@cjhyy/code-shell-core", mainDirectory);
  const mainInternal = globalThis.Bun.resolveSync("@cjhyy/code-shell-core/internal", mainDirectory);
  mock.module(mainCore, () => core);
  mock.module(mainInternal, () => ({ ...internal, downloadCollectionUrl: download }));
  const aliased = await import(pathToFileURL(mainInternal).href);
  assert.equal(aliased.downloadCollectionUrl, download);
  // This is the first import of actual Main, after all guards and the proof spy.
  const { createSourceCollectionService } = await import(
    fromRoot("packages/desktop/src/main/source-collections-service.ts")
  );
  const api = createSourceCollectionService({
    assertCurrent: () => {},
    pick: async () => {
      throw new Error("No local picker in URL fixture");
    },
    references: async () => [],
  });
  let value = await api.create({ label: "Static manuals" });
  value = await api.update(value.definition.id, value.revision, {
    kind: "url",
    url: origin + "/download",
  });
  const added = value.entries[0].entry;
  assert.equal(added.name, "manual.docx");
  assert.equal(added.kind, "url");
  assert.equal(added.url, origin + "/download");
  assert.equal(added.sizeBytes, bytes.length);
  assert.equal(added.sha256, digest(bytes));
  value = await api.update(value.definition.id, value.revision, {
    kind: "refresh",
    entryId: added.id,
  });
  const refreshed = value.entries[0].entry;
  assert.equal(refreshed.id, added.id);
  assert.equal(refreshed.name, "download.pdf");
  assert.equal(refreshed.url, origin + "/download");
  assert.equal(refreshed.sizeBytes, pdf.length);
  assert.equal(refreshed.sha256, digest(pdf));
  assert.equal(download.mock.calls.length, 2);
  assert.ok(download.mock.calls.every(([input]) => input.url === origin + "/download"));
  assert.equal(denied.length, expectedProbes, "Unexpected network attempt after guard probes");
  Object.assign(receipt, {
    valid: true,
    downloads: download.mock.calls.length,
    identityPreserved: refreshed.id === added.id,
    originalName: added.name,
    refreshedName: refreshed.name,
    requestedUrl: refreshed.url,
    addedSha256: added.sha256,
    refreshedSha256: refreshed.sha256,
  });
} catch (error) {
  receipt.error = String(error?.stack ?? error);
  console.error(error);
  process.exitCode = 1;
} finally {
  download?.mockRestore();
  receipt.unexpectedNetworkAttempts = denied.length - expectedProbes;
  persist("receipt.json", receipt);
}
