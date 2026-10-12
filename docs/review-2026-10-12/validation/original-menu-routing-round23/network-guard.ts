import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME?.includes("codeshell-bun-completion-"))
  throw Error("round23 requires maintained isolated Bun HOME");
const repo = process.cwd();
const { installLocalNetworkGuard } = await import(repo + "/scripts/runtime-cost-smoke-isolation.mjs");
installLocalNetworkGuard("http://127.0.0.1:9");
export const attempts: Array<{ kind: string; api: string; target: string }> = [];
const deny = (kind: string, api: string) => (...args: any[]) => {
  attempts.push({ kind, api, target: String(args[0]?.url ?? args[0]?.href ?? args[0]?.hostname ?? args[0] ?? "") });
  throw Error("ROUND23_" + kind.toUpperCase() + "_DENIED:" + api);
};
globalThis.fetch = deny("network", "fetch") as any;
for (const [name, client] of [["http", http], ["https", https]] as const)
  for (const method of ["request", "get"]) (client as any)[method] = deny("network", name + "." + method);
net.connect = net.createConnection = deny("network", "net.connect") as any;
net.Socket.prototype.connect = deny("network", "Socket.connect") as any;
tls.connect = deny("network", "tls.connect") as any;
for (const method of ["spawn", "spawnSync", "fork", "exec", "execSync", "execFile", "execFileSync"])
  (childProcess as any)[method] = deny("child", "child_process." + method);
Bun.connect = deny("network", "Bun.connect") as any;
Bun.listen = deny("network", "Bun.listen") as any;
Bun.spawn = deny("child", "Bun.spawn") as any;
Bun.spawnSync = deny("child", "Bun.spawnSync") as any;
syncBuiltinESMExports();
