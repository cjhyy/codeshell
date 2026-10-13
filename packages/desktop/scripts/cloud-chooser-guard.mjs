import assert from "node:assert/strict";
import { appendFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import children from "node:child_process";

/** Fixture-only guard, installed before production Main/Core imports. */
export function installChooserGuard({
  origins = [],
  workerPreload,
  workerEntry,
  role = "server",
} = {}) {
  const home = process.env.CODESHELL_CLOUD_CHOOSER_HOME;
  assert.ok(home && realpathSync(home) === home && homedir() === home);
  assert.equal(process.env.USERPROFILE, home);
  assert.equal(process.env.CODE_SHELL_HOME, join(home, ".code-shell"));
  assert.equal(process.env.CODE_SHELL_DATA_ROOT, undefined);
  const allowed = new Set(),
    ports = new Set();
  const deny = () => {
    throw new Error("Cloud chooser refused external transport/process");
  };
  const allow = (origin) => {
    const url = new URL(origin);
    if (
      url.origin !== origin ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      !["http:", "https:"].includes(url.protocol)
    )
      deny();
    allowed.add(origin);
    ports.add(Number(url.port));
  };
  for (const origin of origins) allow(origin);
  const check = (url) => {
    if (!allowed.has(new URL(url).origin)) deny();
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
    if (
      options.path ||
      (options.host ?? options.hostname) !== "127.0.0.1" ||
      !ports.has(Number(options.port))
    )
      deny();
    return connect.apply(this, args);
  };
  const secure = tls.connect;
  tls.connect = function (options, ...args) {
    if (
      !options ||
      typeof options !== "object" ||
      options.rejectUnauthorized === false ||
      (options.host ?? options.hostname) !== "127.0.0.1" ||
      !ports.has(Number(options.port))
    )
      deny();
    return secure.call(this, options, ...args);
  };
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    const options = typeof args[0] === "object" ? args[0] : { port: args[0], host: args[1] };
    if (options.path || options.host !== "127.0.0.1" || options.port !== 0) deny();
    this.once("listening", () =>
      allow(`${this instanceof tls.Server ? "https" : "http"}://127.0.0.1:${this.address().port}`),
    );
    return listen.apply(this, args);
  };
  const spawn = children.spawn;
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])
    children[name] = deny;
  if (workerPreload)
    children.spawn = function (command, args, options) {
      // The only allowed product child is this Electron binary's fixed stdio worker.
      if (
        command !== process.execPath ||
        args?.length !== 1 ||
        args[0] !== workerEntry ||
        options?.env?.ELECTRON_RUN_AS_NODE !== "1" ||
        options?.env?.HOME !== home
      )
        deny();
      const child = spawn.call(this, command, ["--import", workerPreload, ...args], options);
      appendFileSync(
        join(home, "chooser-workers.jsonl"),
        JSON.stringify({ pid: child.pid }) + "\n",
        { mode: 0o600 },
      );
      return child;
    };
  syncBuiltinESMExports();
  for (const probe of [
    () => fetch("https://external.invalid/"),
    () => http.get("http://127.0.0.1:1/"),
    () => tls.connect({ host: "127.0.0.1", port: 2, rejectUnauthorized: false }),
    () => children.spawn("sh"),
  ])
    assert.throws(probe, /Cloud chooser refused/);
  appendFileSync(
    join(home, "chooser-guards.jsonl"),
    JSON.stringify({
      pid: process.pid,
      ppid: process.ppid,
      negativeProbes: 4,
      role,
      origins: [...allowed],
    }) + "\n",
    { mode: 0o600 },
  );
}
