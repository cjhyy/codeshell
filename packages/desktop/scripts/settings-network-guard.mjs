import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Static settings acceptance needs local assets and IPC, with no remote origin. */
export async function settingsNetworkGuard(home) {
  const path = join(home, "static-settings-network-guard.cjs");
  await writeFile(
    path,
    `globalThis.__staticSettingsNetworkAttempts = 0;
const deny = () => { globalThis.__staticSettingsNetworkAttempts++; throw new Error("Static settings fixture forbids network"); };
globalThis.fetch = async () => deny();
for (const name of ["node:http", "node:https"]) {
  const transport = require(name); transport.request = deny; transport.get = deny;
}
require("node:module").syncBuiltinESMExports();
if (process.versions.electron) {
  const { app, net } = require("electron");
  net.request = deny; net.fetch = deny;
  app.on("web-contents-created", (_event, contents) => contents.session.webRequest.onBeforeRequest({urls:["http://*/*", "https://*/*"]}, (_details, done) => { globalThis.__staticSettingsNetworkAttempts++; done({cancel:true}); }));
}
`,
    { mode: 0o600 },
  );
  return { mainBootstrap: path, env: { NODE_OPTIONS: `--require ${path}` } };
}
