import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { realpathSync } from "node:fs";

/** Install before Core imports. Only the fixture's already bound listeners mint origins. */
export function installCloudControlConfinement({ nativeWebSockets = false } = {}) {
  if (
    !process.env.HOME ||
    realpathSync(process.env.HOME) !== process.env.HOME ||
    !process.env.HOME.includes("codeshell-bun-completion-")
  )
    throw new Error("Cloud fixture requires the guarded runner's private HOME.");
  const origins = new Set<string>();
  const restores: Array<() => void> = [];
  const deny = () => {
    throw new Error("Cloud fixture refused a non-fixture transport or process.");
  };
  const assertOrigin = (input: string | URL) => {
    if (!origins.has(new URL(input).origin)) deny();
  };
  const originalFetch = globalThis.fetch;
  restores.push(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    assertOrigin(typeof input === "string" || input instanceof URL ? input : input.url);
    return originalFetch(input, { ...init, redirect: "manual" });
  }) as typeof fetch;
  for (const [module, protocol] of [
    [http, "http:"],
    [https, "https:"],
  ] as const) {
    for (const name of ["request", "get"] as const) {
      const original = module[name];
      restores.push(() => {
        (module as any)[name] = original;
      });
      (module as any)[name] = function (input: any, ...args: any[]) {
        const url = typeof input === "string" || input instanceof URL ? new URL(input) : undefined;
        const options = url ? (typeof args[0] === "object" ? args[0] : {}) : input;
        const scheme = options.protocol ?? url?.protocol ?? protocol;
        // The reviewed ws client supplies its own plain net connector. Native
        // fixtures may use it only for already allowlisted numeric loopback
        // origins; the Socket.connect guard below independently checks its TCP
        // destination. Custom DNS, agents, sockets and TLS stay forbidden.
        const nativeConnector =
          nativeWebSockets &&
          scheme === "http:" &&
          (options.hostname ?? options.host ?? url?.hostname) === "127.0.0.1";
        if (
          options.socketPath ||
          (options.createConnection && !nativeConnector) ||
          options.lookup ||
          options.agent
        )
          deny();
        assertOrigin(
          `${scheme}//${options.hostname ?? options.host ?? url?.hostname ?? "localhost"}:${options.port ?? url?.port ?? (scheme === "http:" ? 80 : 443)}`,
        );
        return (original as any).call(this, input, ...args);
      };
    }
  }
  const originalConnect = net.Socket.prototype.connect;
  restores.push(() => {
    net.Socket.prototype.connect = originalConnect;
  });
  net.Socket.prototype.connect = function (...args: any[]) {
    const values = Array.isArray(args[0]) ? args[0] : args;
    const options =
      typeof values[0] === "object"
        ? values[0]
        : { port: values[0], host: typeof values[1] === "string" ? values[1] : undefined };
    if (options.path || !options.port) deny();
    assertOrigin(`http://${options.hostname ?? options.host ?? "localhost"}:${options.port}`);
    return (originalConnect as any).apply(this, args);
  } as typeof originalConnect;
  const originalTls = tls.connect;
  restores.push(() => {
    tls.connect = originalTls;
  });
  tls.connect = deny as typeof tls.connect;
  for (const name of [
    "spawn",
    "spawnSync",
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "fork",
  ]) {
    const original = (childProcess as any)[name];
    restores.push(() => {
      (childProcess as any)[name] = original;
    });
    (childProcess as any)[name] = deny;
  }
  syncBuiltinESMExports();
  let rejected = 0;
  for (const probe of [
    () => globalThis.fetch("https://external.invalid/"),
    () => http.get("http://127.0.0.1:1"),
    () => net.connect(2, "127.0.0.1"),
    () => childProcess.spawn("sh"),
  ]) {
    try {
      probe();
    } catch {
      rejected++;
    }
  }
  if (rejected !== 4) throw new Error("Cloud fixture negative probes failed.");
  const allow = (origin: string) => {
    const url = new URL(origin);
    if (
      url.origin !== origin ||
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port
    )
      deny();
    origins.add(origin);
  };
  return {
    allow,
    restore() {
      for (const restore of restores.reverse()) restore();
      syncBuiltinESMExports();
    },
  };
}
