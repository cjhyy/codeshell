import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";

/** Install before importing Main/Core/Services. Owned listeners mint the only origins. */
export function installCloudMainGuard() {
  const home = process.env.HOME;
  if (
    !home ||
    realpathSync(home) !== home ||
    createHash("sha256").update(home).digest("hex") !== process.env.CLOUD_MAIN_HOME_HASH
  )
    throw new Error("Cloud Main interop requires a private real HOME");
  const origins = new Set(),
    ports = new Set();
  const deny = () => {
    throw new Error("Cloud Main interop refused external transport/process");
  };
  const check = (url) => {
    if (!origins.has(new URL(url).origin)) deny();
  };
  const fetcher = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    check(typeof input === "string" || input instanceof URL ? input : input.url);
    if (init?.dispatcher) deny();
    return fetcher(input, { ...init, redirect: "manual" });
  };
  for (const [module, protocol] of [
    [http, "http:"],
    [https, "https:"],
  ]) {
    for (const name of ["request", "get"]) {
      const original = module[name];
      module[name] = function (input, ...args) {
        const url = typeof input === "string" || input instanceof URL ? new URL(input) : undefined;
        const options = url ? (typeof args[0] === "object" ? args[0] : {}) : input;
        if (
          options.socketPath ||
          options.createConnection ||
          options.lookup ||
          options.agent ||
          options.rejectUnauthorized === false
        )
          deny();
        const scheme = options.protocol ?? url?.protocol ?? protocol;
        check(
          `${scheme}//${options.hostname ?? options.host ?? url?.hostname ?? "localhost"}:${options.port ?? url?.port ?? (scheme === "https:" ? 443 : 80)}`,
        );
        return original.call(this, input, ...args);
      };
    }
  }
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const values = Array.isArray(args[0]) ? args[0] : args;
    const options =
      typeof values[0] === "object"
        ? values[0]
        : { port: values[0], host: typeof values[1] === "string" ? values[1] : undefined };
    if (options.path || options.host !== "127.0.0.1" || !ports.has(Number(options.port))) deny();
    return connect.apply(this, args);
  };
  const secure = tls.connect;
  tls.connect = function (options, ...args) {
    if (
      !options ||
      typeof options !== "object" ||
      options.rejectUnauthorized === false ||
      options.host !== "127.0.0.1" ||
      !ports.has(Number(options.port))
    )
      deny();
    return secure.call(this, options, ...args);
  };
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])
    childProcess[name] = deny;
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    const options = typeof args[0] === "object" ? args[0] : { port: args[0], host: args[1] };
    if (options.path || options.host !== "127.0.0.1") deny();
    this.once("listening", () => {
      const port = this.address().port;
      ports.add(port);
      origins.add(`${this instanceof tls.Server ? "https" : "http"}://127.0.0.1:${port}`);
    });
    return listen.apply(this, args);
  };
  syncBuiltinESMExports();
  let refused = 0;
  for (const probe of [
    () => fetch("https://external.invalid"),
    () => http.get("http://127.0.0.1:1"),
    () => tls.connect({ host: "127.0.0.1", port: 2, rejectUnauthorized: false }),
    () => childProcess.spawn("sh"),
  ]) {
    try {
      probe();
    } catch {
      refused++;
    }
  }
  if (refused !== 4) throw new Error("Cloud Main isolation probes failed");
  return { negativeProbes: refused, homeHash: process.env.CLOUD_MAIN_HOME_HASH };
}
