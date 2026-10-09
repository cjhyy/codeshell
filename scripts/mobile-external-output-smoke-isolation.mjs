// Test-only Node preload. It runs before any Core/host import, including fake CLIs.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { appendFileSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";

const marker = Symbol.for("codeshell.external-output.fixture-guard");
export function installExternalOutputGuard() {
  if (globalThis[marker]) return;
  const home = process.env.HOME;
  if (
    !home ||
    realpathSync(home) !== home ||
    process.env.CODESHELL_OUTPUT_HOME_HASH !== createHash("sha256").update(home).digest("hex")
  )
    throw new Error("External output fixture requires its real private HOME");
  const origins = new Set(JSON.parse(process.env.CODESHELL_OUTPUT_ORIGINS ?? "[]"));
  for (const origin of origins) {
    const url = new URL(origin);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      url.origin !== origin
    )
      throw new Error("Invalid external output fixture origin");
  }
  const record = (event, extra = {}) => {
    if (process.env.CODESHELL_OUTPUT_GUARD_LOG)
      appendFileSync(
        process.env.CODESHELL_OUTPUT_GUARD_LOG,
        JSON.stringify({
          event,
          pid: process.pid,
          ppid: process.ppid,
          uid: process.getuid?.(),
          homeHash: process.env.CODESHELL_OUTPUT_HOME_HASH,
          ...extra,
        }) + "\n",
        { mode: 0o600 },
      );
  };
  const deny = () => {
    record("blocked", { caller: new Error().stack.split("\n").slice(2, 6) });
    throw new Error("External output fixture refused a non-fixture transport or process");
  };
  const hashFile = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const children = JSON.parse(process.env.CODESHELL_OUTPUT_CHILDREN ?? "[]");
  if (
    children.length !== 2 ||
    !children.every(
      (entry) =>
        entry.path.startsWith(`${process.env.CODESHELL_OUTPUT_ROOT}/bin/`) &&
        /^[a-f0-9]{64}$/.test(entry.hash),
    )
  )
    throw new Error("Invalid fixture process allowlist");
  const gitArgs = new Set([
    JSON.stringify(["rev-parse", "--show-toplevel"]),
    JSON.stringify(["rev-parse", "--is-inside-work-tree"]),
    JSON.stringify(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  ]);
  const checkGit = (command, args, options = {}) => {
    if (command !== "git" && command !== process.env.CODESHELL_OUTPUT_GIT) return false;
    const env = options.env ?? process.env;
    if (
      options.shell ||
      options.detached ||
      !gitArgs.has(JSON.stringify(args)) ||
      realpathSync(options.cwd) !== `${process.env.CODESHELL_OUTPUT_ROOT}/workspace` ||
      env.HOME !== home ||
      env.NODE_OPTIONS !== process.env.NODE_OPTIONS ||
      env.PATH.split(":")[0] !== `${process.env.CODESHELL_OUTPUT_ROOT}/bin` ||
      realpathSync(`${process.env.CODESHELL_OUTPUT_ROOT}/bin/git`) !==
        process.env.CODESHELL_OUTPUT_GIT ||
      hashFile(process.env.CODESHELL_OUTPUT_GIT) !== process.env.CODESHELL_OUTPUT_GIT_HASH
    )
      deny();
    record("allowed-git-metadata");
    return true;
  };
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = function (command, args = [], options = {}) {
    if (checkGit(command, args, options)) return originalSpawn.call(this, command, args, options);
    if (options.shell || options.detached) deny();
    const env = options.env ?? process.env;
    if (
      env.HOME !== home ||
      env.CODESHELL_OUTPUT_HOME_HASH !== process.env.CODESHELL_OUTPUT_HOME_HASH ||
      env.NODE_OPTIONS !== process.env.NODE_OPTIONS
    )
      deny();
    const fixture = children.find((entry) => command === entry.path || command === entry.command);
    let kind;
    if (fixture) {
      if (
        lstatSync(fixture.path).isSymbolicLink() ||
        hashFile(fixture.path) !== fixture.hash ||
        env.PATH.split(":")[0] !== `${process.env.CODESHELL_OUTPUT_ROOT}/bin`
      )
        deny();
      kind = fixture.command;
    } else {
      if (
        command !== process.execPath ||
        args.length !== 3 ||
        args[0] !== process.env.CODESHELL_OUTPUT_COLD_ENTRY ||
        args[1] !== "cold" ||
        !/^[a-z0-9-]+$/.test(args[2]) ||
        hashFile(args[0]) !== process.env.CODESHELL_OUTPUT_COLD_HASH
      )
        deny();
      kind = "cold-main";
    }
    record("allowed-spawn", { kind });
    return originalSpawn.call(this, command, args, options);
  };
  for (const name of ["execFile", "execFileSync"]) {
    const original = childProcess[name];
    childProcess[name] = function (command, args = [], options = {}, ...rest) {
      if (!checkGit(command, args, options)) deny();
      return original.call(
        this,
        command,
        args,
        { ...options, timeout: Math.min(options.timeout ?? 5000, 5000) },
        ...rest,
      );
    };
  }
  for (const name of ["spawnSync", "exec", "execSync", "fork"]) childProcess[name] = deny;
  const assertOrigin = (input) => {
    const origin = new URL(input).origin;
    if (!origins.has(origin)) deny();
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    assertOrigin(typeof input === "string" || input instanceof URL ? input : input.url);
    if (init?.dispatcher) deny();
    return originalFetch(input, { ...init, redirect: "error" });
  };
  for (const [module, protocol] of [
    [http, "http:"],
    [https, "https:"],
  ]) {
    for (const name of ["request", "get"]) {
      const original = module[name];
      module[name] = function (input, ...args) {
        const isUrl = typeof input === "string" || input instanceof URL;
        const url = isUrl ? new URL(input) : undefined;
        const options = isUrl ? (typeof args[0] === "object" ? args[0] : {}) : (input ?? {});
        if (options.socketPath || options.createConnection || options.lookup || options.agent)
          deny();
        const scheme = options.protocol ?? url?.protocol ?? protocol;
        assertOrigin(
          `${scheme}//${options.hostname ?? options.host ?? url?.hostname ?? "localhost"}:${options.port ?? url?.port ?? (scheme === "http:" ? "80" : "443")}`,
        );
        return original.call(this, input, ...args);
      };
    }
  }
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const values = Array.isArray(args[0]) ? args[0] : args;
    const options =
      typeof values[0] === "object"
        ? values[0]
        : { port: values[0], host: typeof values[1] === "string" ? values[1] : undefined };
    if (options.path || !options.port) deny();
    assertOrigin(`http://${options.hostname ?? options.host ?? "localhost"}:${options.port}`);
    record("allowed-loopback", { port: Number(options.port) });
    return originalConnect.apply(this, args);
  };
  tls.connect = deny;
  // Only listeners created by this fixture process mint exact loopback origins.
  const originalListen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    const options = typeof args[0] === "object" ? args[0] : { port: args[0], host: args[1] };
    if (options.host !== "127.0.0.1" || options.path) deny();
    this.once("listening", () => {
      const address = this.address();
      const origin = `http://127.0.0.1:${address.port}`;
      origins.add(origin);
      process.env.CODESHELL_OUTPUT_ORIGINS = JSON.stringify([...origins]);
      record("owned-listener", { origin });
    });
    return originalListen.apply(this, args);
  };
  syncBuiltinESMExports();
  globalThis[marker] = true;
  let refused = 0;
  for (const probe of [
    () => globalThis.fetch("https://example.invalid/"),
    () => http.get("http://127.0.0.1:1/"),
    () => net.connect({ host: "127.0.0.1", port: 2 }),
    () => childProcess.spawn("sh", ["-c", "exit 0"]),
  ]) {
    try {
      probe();
    } catch {
      refused++;
    }
  }
  if (refused !== 4) throw new Error("External output confinement negative probe failed");
  record("pre-core", {
    negativeProbes: refused,
    nodeVersion: process.versions.node,
    execPath: process.execPath,
    nodeBinaryHash: hashFile(process.execPath),
  });
}
if (process.env.CODESHELL_OUTPUT_HOME_HASH) installExternalOutputGuard();
