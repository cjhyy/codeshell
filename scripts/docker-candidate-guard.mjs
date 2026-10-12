// Test-only preload. No product or Core imports are permitted in this module.
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import dgram from "node:dgram";
import http2 from "node:http2";
import children from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

export const candidateHash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const refuse = () => {
  throw new Error("Docker candidate refused an unowned transport/process/policy");
};
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const marker = Symbol.for("codeshell.docker-candidate.pre-core");
const modulePath = fileURLToPath(import.meta.url);
const owned = (stat) => !process.getuid || stat.uid === process.getuid();

/** Pin both bytes and pathname; do not follow a replaced or hard-linked policy. */
export function candidateFile(path, { maximum = 1024 * 1024, privateFile = false } = {}) {
  if (!isAbsolute(path) || realpathSync(path) !== path) refuse();
  const before = lstatSync(path);
  if (
    !before.isFile() ||
    before.nlink !== 1 ||
    before.size > maximum ||
    (privateFile && (before.mode & 0o077 || !owned(before)))
  )
    refuse();
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino) refuse();
    const bytes = readFileSync(fd),
      after = fstatSync(fd),
      named = lstatSync(path);
    if (
      bytes.length > maximum ||
      [after, named].some(
        (value) =>
          !value.isFile() ||
          value.nlink !== 1 ||
          value.dev !== opened.dev ||
          value.ino !== opened.ino ||
          value.size !== opened.size ||
          value.mtimeMs !== opened.mtimeMs ||
          value.ctimeMs !== opened.ctimeMs,
      )
    )
      refuse();
    return { bytes, sha256: candidateHash(bytes), dev: opened.dev, ino: opened.ino };
  } finally {
    closeSync(fd);
  }
}

export function installDockerCandidateGuard(config, { dockerCommand } = {}) {
  if (globalThis[marker]) refuse();
  if (
    !config ||
    config.version !== 1 ||
    !isAbsolute(config.home) ||
    !isAbsolute(config.dataRoot) ||
    !isAbsolute(config.receipt) ||
    !Array.isArray(config.origins) ||
    !Array.isArray(config.listeners) ||
    !Array.isArray(config.children) ||
    config.origins.length > 32 ||
    config.listeners.length > 16 ||
    config.children.length > 256
  )
    refuse();
  const home = realpathSync(config.home);
  if (
    home !== config.home ||
    process.env.HOME !== home ||
    process.env.USERPROFILE !== home ||
    process.env.CODE_SHELL_HOME !== `${home}/.code-shell` ||
    (process.env.CODE_SHELL_DATA_ROOT &&
      !process.env.CODE_SHELL_DATA_ROOT.startsWith(`${config.dataRoot}/`))
  )
    refuse();
  const homeStat = lstatSync(home);
  if (
    !homeStat.isDirectory() ||
    homeStat.isSymbolicLink() ||
    homeStat.mode & 0o077 ||
    !owned(homeStat)
  )
    refuse();
  if (
    !isAbsolute(config.preload) ||
    /\s/.test(config.preload) ||
    process.env.NODE_OPTIONS !== `--import=${config.preload}`
  )
    refuse();
  const preloadPin = candidateFile(config.preload);
  if (preloadPin.sha256 !== config.preloadHash) refuse();
  const modulePin = candidateFile(modulePath);
  if (modulePin.sha256 !== config.guardHash) refuse();
  const role = process.env.CODESHELL_DOCKER_CANDIDATE_ROLE ?? config.role;
  if (!["driver", "controller", "runtime", "worker", "installer", "model"].includes(role)) refuse();
  const origins = new Set();
  const allowOrigin = (origin) => {
    const url = new URL(origin);
    if (
      url.origin !== origin ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      !["http:", "https:"].includes(url.protocol)
    )
      refuse();
    origins.add(origin);
  };
  for (const origin of config.origins ?? []) allowOrigin(origin);
  const check = (input) => {
    if (!origins.has(new URL(input).origin)) refuse();
  };
  const record = (event, extra = {}) => {
    const directory = lstatSync(dirname(config.receipt));
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      directory.mode & 0o077 ||
      !owned(directory) ||
      realpathSync(dirname(config.receipt)) !== dirname(config.receipt)
    )
      refuse();
    const fd = openSync(
      config.receipt,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.mode & 0o077 ||
        !owned(stat) ||
        stat.size > 4 * 1024 * 1024
      )
        refuse();
      const line = Buffer.from(
        JSON.stringify({
          event,
          pid: process.pid,
          ppid: process.ppid,
          role,
          homeHash: candidateHash(home),
          preloadHash: preloadPin.sha256,
          policyHash: process.env.CODESHELL_DOCKER_CANDIDATE_CONFIG_HASH,
          ...extra,
        }) + "\n",
      );
      let offset = 0;
      while (offset < line.length) {
        const count = writeSync(fd, line, offset, line.length - offset);
        if (!count) refuse();
        offset += count;
      }
    } finally {
      closeSync(fd);
    }
  };
  const fetcher = globalThis.fetch;
  globalThis.fetch = (input, options) => {
    check(typeof input === "string" || input instanceof URL ? input : input.url);
    if (options?.dispatcher) refuse();
    return fetcher(input, { ...options, redirect: "error" });
  };
  for (const [module, scheme] of [
    [http, "http:"],
    [https, "https:"],
  ])
    for (const name of ["request", "get"]) {
      const original = module[name];
      module[name] = function (input, ...args) {
        const url = typeof input === "string" || input instanceof URL ? new URL(input) : undefined;
        const options = url ? (typeof args[0] === "object" ? args[0] : {}) : input;
        if (
          !options ||
          options.socketPath ||
          options.createConnection ||
          options.lookup ||
          (options.agent && options.agent !== false) ||
          options.rejectUnauthorized === false
        )
          refuse();
        const protocol = options.protocol ?? url?.protocol ?? scheme;
        check(
          `${protocol}//${options.hostname ?? options.host ?? url?.hostname ?? "localhost"}:${options.port ?? url?.port ?? (protocol === "https:" ? 443 : 80)}`,
        );
        return original.call(this, input, ...args);
      };
    }
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const values = Array.isArray(args[0]) ? args[0] : args;
    const options =
      typeof values[0] === "object" ? values[0] : { port: values[0], host: values[1] };
    if (
      !options ||
      options.path ||
      options.lookup ||
      (options.host ?? options.hostname) !== "127.0.0.1"
    )
      refuse();
    if (!["http:", "https:"].some((scheme) => origins.has(`${scheme}//127.0.0.1:${options.port}`)))
      refuse();
    return connect.apply(this, args);
  };
  const secure = tls.connect;
  tls.connect = function (options, ...args) {
    if (
      !options ||
      typeof options !== "object" ||
      options.rejectUnauthorized === false ||
      options.socket ||
      options.lookup
    )
      refuse();
    check(`https://${options.host ?? options.hostname}:${options.port}`);
    return secure.call(this, options, ...args);
  };
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    const options = typeof args[0] === "object" ? args[0] : { port: args[0], host: args[1] };
    if (
      !options ||
      options.path ||
      !(config.listeners ?? []).some(
        (value) => value.host === options.host && value.port === options.port,
      )
    )
      refuse();
    this.once("listening", () => {
      if (options.host === "127.0.0.1")
        allowOrigin(
          `${this instanceof tls.Server ? "https" : "http"}://127.0.0.1:${this.address().port}`,
        );
      record("listener", { host: options.host, port: this.address().port });
    });
    return listen.apply(this, args);
  };
  // Node performs lookup even for numeric Server.listen hosts. Permit only
  // those literal addresses; no resolver is ever reached for a hostname.
  const lookup = dns.lookup,
    lookupPromise = dns.promises.lookup;
  const literal = (host) =>
    host === "127.0.0.1" ||
    (host === "0.0.0.0" && config.listeners.some((value) => value.host === host));
  dns.lookup = function (host, ...args) {
    if (!literal(host)) refuse();
    return lookup.call(this, host, ...args);
  };
  dns.promises.lookup = function (host, ...args) {
    if (!literal(host)) refuse();
    return lookupPromise.call(this, host, ...args);
  };
  for (const method of ["resolve", "resolve4", "resolve6", "reverse"])
    dns[method] = dns.promises[method] = refuse;
  dgram.createSocket = http2.connect = refuse;
  const originals = { spawn: children.spawn, execFile: children.execFile };
  const permitChild = (command, args, options = {}) => {
    if (!Array.isArray(args) || options.shell || options.detached) refuse();
    const env = options.env ?? process.env;
    if (
      env.HOME !== home ||
      env.USERPROFILE !== home ||
      env.CODE_SHELL_HOME !== process.env.CODE_SHELL_HOME ||
      env.NODE_OPTIONS !== process.env.NODE_OPTIONS ||
      env.CODESHELL_DOCKER_CANDIDATE_CONFIG !== process.env.CODESHELL_DOCKER_CANDIDATE_CONFIG ||
      env.CODESHELL_DOCKER_CANDIDATE_CONFIG_HASH !==
        process.env.CODESHELL_DOCKER_CANDIDATE_CONFIG_HASH
    )
      refuse();
    const descriptor = (config.children ?? []).find(
      (value) => (command === value.path || command === value.command) && same(value.args, args),
    );
    if (
      !descriptor ||
      candidateFile(descriptor.path, { maximum: 128 * 1024 * 1024 }).sha256 !== descriptor.sha256 ||
      (descriptor.entry && candidateFile(descriptor.entry).sha256 !== descriptor.entryHash) ||
      (descriptor.cwd && realpathSync(options.cwd ?? process.cwd()) !== descriptor.cwd)
    )
      refuse();
    if (
      candidateFile(config.preload).sha256 !== preloadPin.sha256 ||
      candidateFile(modulePath).sha256 !== modulePin.sha256
    )
      refuse();
    record("allowed-child", {
      childRole: descriptor.role,
      argvHash: candidateHash(JSON.stringify(args)),
    });
    return {
      command: descriptor.path,
      args,
      options: {
        ...options,
        env: { ...env, CODESHELL_DOCKER_CANDIDATE_ROLE: descriptor.role ?? role },
      },
    };
  };
  for (const method of ["spawn", "execFile"])
    children[method] = function (command, args, options, callback) {
      if (typeof options === "function") {
        callback = options;
        options = {};
      }
      if (dockerCommand && method === "execFile" && command === config.docker?.command)
        return dockerCommand({
          command,
          args,
          options,
          callback,
          original: originals.execFile,
          allowOrigin,
          record,
        });
      const allowed = permitChild(command, args, options);
      const child = originals[method](allowed.command, allowed.args, allowed.options, callback);
      record("child-started", { childPid: child.pid });
      return child;
    };
  children.execFile[Symbol.for("nodejs.util.promisify.custom")] = (command, args, options) =>
    new Promise((resolve, reject) =>
      children.execFile(command, args, options, (error, stdout, stderr) =>
        error ? reject(error) : resolve({ stdout, stderr }),
      ),
    );
  for (const method of ["spawnSync", "exec", "execSync", "execFileSync", "fork"])
    children[method] = refuse;
  syncBuiltinESMExports();
  const probes = [
    () => fetch("https://external.invalid/"),
    () => http.get("http://127.0.0.1:1"),
    () => net.connect(2, "127.0.0.1"),
    () => tls.connect({ host: "127.0.0.1", port: 3 }),
    () => dgram.createSocket("udp4"),
    () => children.spawn("sh", ["-c", "exit 0"]),
  ];
  for (const probe of probes) assert.throws(probe, /Docker candidate refused/);
  globalThis[marker] = Object.freeze({ role, negativeProbes: probes.length });
  record("pre-core", { negativeProbes: probes.length });
  return { allowOrigin, record };
}
