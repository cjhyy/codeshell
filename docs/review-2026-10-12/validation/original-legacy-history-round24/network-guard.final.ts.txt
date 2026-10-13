import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import dgram from "node:dgram";
import childProcess from "node:child_process";
import workerThreads from "node:worker_threads";
import { realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";

const privateHome = process.env.HOME;
if (
  !privateHome ||
  !privateHome.includes("codeshell-bun-completion-") ||
  process.env.CODE_SHELL_TEST_HOME !== join(privateHome, ".code-shell") ||
  process.env.CODE_SHELL_HOME !== process.env.CODE_SHELL_TEST_HOME ||
  realpathSync(privateHome) !== privateHome ||
  (statSync(privateHome).mode & 0o077) !== 0
) throw Error("MENU_RECENTS_REQUIRES_MAINTAINED_PRIVATE_HOME");

// Install the maintained exact-origin guard before any product/Core import,
// then deny even that dummy origin: this fixture needs no listener or requests.
const { installLocalNetworkGuard } = await import(process.cwd() + "/scripts/runtime-cost-smoke-isolation.mjs");
installLocalNetworkGuard("http://127.0.0.1:9");

export const attempts: Array<{ kind: string; api: string; target: string }> = [];
export function deny(kind: string, api: string) {
  return (...args: any[]): never => {
    attempts.push({ kind, api, target: String(args[0]?.url ?? args[0]?.href ?? args[0]?.hostname ?? args[0] ?? "") });
    throw Error("MENU_RECENTS_" + kind.toUpperCase() + "_DENIED:" + api);
  };
}
globalThis.fetch = deny("network", "fetch") as any;
for (const [name, client] of [["http", http], ["https", https]] as const) {
  for (const method of ["request", "get", "createServer"]) (client as any)[method] = deny("network", name + "." + method);
}
net.connect = net.createConnection = deny("network", "net.connect") as any;
net.Socket.prototype.connect = deny("network", "Socket.connect") as any;
net.createServer = deny("network", "net.createServer") as any;
tls.connect = deny("network", "tls.connect") as any;
tls.createServer = deny("network", "tls.createServer") as any;
dgram.createSocket = deny("network", "dgram.createSocket") as any;
for (const method of ["spawn", "spawnSync", "fork", "exec", "execSync", "execFile", "execFileSync"])
  (childProcess as any)[method] = deny("child", "child_process." + method);
(workerThreads as any).Worker = class { constructor(...args: any[]) { deny("child", "worker_threads.Worker")(...args); } };
globalThis.WebSocket = class { constructor(...args: any[]) { deny("network", "WebSocket")(...args); } } as any;
if ("Worker" in globalThis) (globalThis as any).Worker = class { constructor(...args: any[]) { deny("child", "Worker")(...args); } };
Bun.connect = deny("network", "Bun.connect") as any;
Bun.listen = deny("network", "Bun.listen") as any;
Bun.serve = deny("network", "Bun.serve") as any;
Bun.spawn = deny("child", "Bun.spawn") as any;
Bun.spawnSync = deny("child", "Bun.spawnSync") as any;
syncBuiltinESMExports();

export const guardScope = {
  maintainedPrivateHome: true,
  exactOriginInstalledBeforeProductImports: "http://127.0.0.1:9",
  dummyOriginAlsoDenied: true,
  networkAndChildAPIs: "fetch/http(s)/net/tls/dgram/WebSocket/Bun listeners and child_process/worker_threads/Worker/Bun spawn",
  limitation: "in-process guards, not an OS sandbox or universal direct-native-network confinement",
};
