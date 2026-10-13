import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
const root = process.argv[2]!;
process.env.HOME = join(root, "home");
process.env.CODE_SHELL_HOME = join(root, "state");
process.env.CODE_SHELL_TEST_HOME = join(root, "state");
const originalFetch = globalThis.fetch;
let allowedOrigin = "";
globalThis.fetch = ((input: any, init?: any) => {
  const url = new URL(typeof input === "string" ? input : (input.url ?? String(input)));
  if (!allowedOrigin || url.origin !== allowedOrigin)
    throw new Error("Fixture denied non-Hub network");
  return originalFetch(input, init);
}) as typeof fetch;
const repo = process.argv[3]!;
const { installReviewedLocalPanelApp, previewLocalPanelApp } = await import(
  repo + "/packages/core/dist/index.js"
);
const { startHeadlessServer } = await import(repo + "/packages/server/dist/index.serve.js");
const cwd = join(root, "workspace"),
  source = join(root, "source"),
  dataDir = join(root, "data");
await mkdir(cwd, { recursive: true });
await mkdir(join(source, ".codeshell-panel"), { recursive: true });
await mkdir(join(source, "app"));
await writeFile(
  join(source, ".codeshell-panel/panel.json"),
  JSON.stringify({
    schemaVersion: 1,
    id: "close-fixture",
    title: { default: "Close fixture" },
    version: "1.0.0",
    entry: "app/index.html",
    icon: "panel",
    placement: "right-dock",
    singleton: true,
    permissions: ["context.workspace", "process"],
  }),
);
await writeFile(join(source, "app/index.html"), "<!doctype html><html><body>fixture</body></html>");
const input = { kind: "dir", path: source } as const;
const preview = await previewLocalPanelApp(input);
await installReviewedLocalPanelApp(input, preview.reviewToken, new Date().toISOString());
await mkdir(join(dataDir, "panel-bin"), { recursive: true });
await symlink(process.execPath, join(dataDir, "panel-bin", "fixture-node"));
const server = await startHeadlessServer({
  host: "127.0.0.1",
  port: 0,
  cwd,
  dataDir,
  workerEntryPath: join(root, "unused.cjs"),
  authMode: "hub",
});
allowedOrigin = server.url;
const setup = await fetch(server.url + "/api/v1/auth/setup", {
  method: "POST",
  headers: { "content-type": "application/json", origin: server.url },
  body: JSON.stringify({
    token: server.bootstrapToken,
    username: "fixture",
    password: "fixture-close-password",
  }),
});
if (setup.status !== 200) throw new Error("Setup failed " + (await setup.text()));
const cookie = setup.headers.get("set-cookie")!.split(";", 1)[0]!;
async function request(path: string, method = "GET", value?: unknown) {
  const response = await fetch(server.url + path, {
    method,
    headers: { cookie, origin: server.url, "content-type": "application/json" },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  if (response.status !== 200)
    throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return (await response.json()) as any;
}
const catalog = await request("/api/v1/panels");
const bound = await request("/api/v1/panels/close-fixture/binding", "PATCH", {
  bound: true,
  expectedRevision: catalog.panels[0].revision,
});
const grant = await request("/api/v1/panels/runtime/prepare", "POST", {
  appId: "close-fixture",
  revision: bound.panels[0].revision,
});
const api = `/api/v1/panels/runtime/${grant.instanceId}`;
const call = (method: string, params?: unknown) =>
  request(api + "/call", "POST", { method, params });
const executable = await call("process.find", { name: "fixture-node" });
const directory = await call("filesystem.getKnownDirectory", { name: "project" });
const program = `const fs=require("node:fs");process.on("SIGTERM",()=>{});fs.writeFileSync(${JSON.stringify(join(root, "native-pid.json"))},JSON.stringify({nativePid:process.pid}));process.stdout.write(JSON.stringify({nativePid:process.pid})+"\\n");setInterval(()=>{},1000);`;
const starting = call("process.spawn", {
  executableHandle: executable.handle,
  directoryHandle: directory.handle,
  args: ["-e", program],
});
let nativePid = 0;
const deadline = Date.now() + 5000;
const confirmed = new Set<string>();
while (Date.now() < deadline && !nativePid) {
  const events = await request(api + "/events?after=0");
  for (const event of events.events) {
    if (event.event === "host.confirm" && !confirmed.has(event.payload.requestId)) {
      confirmed.add(event.payload.requestId);
      await request(api + "/confirm", "POST", {
        requestId: event.payload.requestId,
        allowed: true,
      });
    }
    if (event.event === "process.output" && event.payload.text?.includes("nativePid"))
      nativePid = JSON.parse(event.payload.text.trim()).nativePid;
  }
  if (!nativePid) await new Promise((resolve) => setTimeout(resolve, 5));
}
await starting;
if (!nativePid) throw new Error("Native fixture did not become ready");
const beforeClose = Date.now();
await server.close();
console.log(
  JSON.stringify({
    nativePid,
    closeReturned: true,
    closeElapsedMs: Date.now() - beforeClose,
    hostRuntime: process.version,
    hostExecutable: process.execPath,
    path: "real authenticated Hub Panel process.spawn -> server.close",
  }),
);
// This is the production serve CLI's final step after server.close resolves.
process.exit(0);
