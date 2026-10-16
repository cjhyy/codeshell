import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { isAbsolute, join, relative } from "node:path";
import tls from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";

const appPath = realpathSync(fileURLToPath(new URL(".", import.meta.url)));
const home = realpathSync(process.env.HOME);
assert.equal(process.env.USERPROFILE, home);
assert.equal(process.env.CODE_SHELL_HOME, join(home, ".code-shell"));
assert.equal(process.env.CODE_SHELL_TEST_HOME, process.env.CODE_SHELL_HOME);
assert.equal(process.env.NODE_OPTIONS, undefined);

let networkAttempts = 0;
const deny = () => {
  networkAttempts++;
  throw new Error("Packaged Link provider fixture denies all network");
};
// This guard runs before either external Core/Link or the generated bundle imports.
globalThis.fetch = deny;
http.request = deny;
http.get = deny;
https.request = deny;
https.get = deny;
net.connect = deny;
net.createConnection = deny;
net.Socket.prototype.connect = deny;
tls.connect = deny;
syncBuiltinESMExports();

const bundle = new URL(process.argv[2]);
const bundleRelativePath = relative(appPath, fileURLToPath(bundle));
assert.ok(bundleRelativePath && !isAbsolute(bundleRelativePath));
assert.ok(!bundleRelativePath.startsWith(".."));
assert.equal(bundle.href, pathToFileURL(join(appPath, "out/main/link-provider-module.mjs")).href);
for (const missing of [
  "@cjhyy/code-shell-server/links",
  "@cjhyy/code-shell-host",
  "@cjhyy/code-shell-web",
])
  assert.throws(() => import.meta.resolve(missing), { code: "ERR_MODULE_NOT_FOUND" });

const coreUrl = import.meta.resolve("@cjhyy/code-shell-core");
const linkUrl = import.meta.resolve("@cjhyy/code-shell-link");
for (const url of [coreUrl, linkUrl]) {
  const path = relative(appPath, realpathSync(fileURLToPath(url)));
  assert.ok(path && !isAbsolute(path) && !path.startsWith(".."));
}
const core = await import(coreUrl);
const { LinkOperationError } = await import(linkUrl);
assert.deepEqual(core.listLocalLinkProviders(), []);
const product = await import(bundle.href);
assert.deepEqual(Object.keys(product), ["createLinkProviderModule"]);
assert.deepEqual(core.listLocalLinkProviders(), [], "importing the factory cannot install it");
assert.equal(product.createLinkProviderModule().id, "codeshell-link-providers");
const providerIds = core
  .listLocalLinkProviders()
  .map((provider) => provider.id)
  .sort();
assert.deepEqual(providerIds, [
  "airtable",
  "figma",
  "github",
  "gitlab",
  "linear",
  "notion",
  "sentry",
  "slack",
  "todoist",
  "vercel",
]);
const github = core.getLocalLinkProvider("github");
product.createLinkProviderModule();
assert.equal(core.listLocalLinkProviders().length, 10);
assert.equal(core.getLocalLinkProvider("github"), github, "registration is idempotent");
const figmaFile = core
  .getLocalLinkProvider("figma")
  .actions.find((action) => action.id === "get_file");
await assert.rejects(
  figmaFile.execute({ token: "synthetic-never-sent", params: { file_key: "Fixture", depth: 2 } }),
  (error) => error instanceof LinkOperationError && error.code === "invalid_input",
);
assert.equal(networkAttempts, 0);
process.stdout.write(
  JSON.stringify({
    isolatedAppBoundary: true,
    serverWorkspaceAbsent: true,
    providers: providerIds,
    sharedCoreRegistry: true,
    sharedLinkErrorClass: true,
    networkAttempts,
  }),
);
