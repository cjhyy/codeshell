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
import workers from "node:worker_threads";
import inspector from "node:inspector";
import { createHash } from "node:crypto";
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  realpathSync,
  readFileSync,
  readSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

export const candidateHash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const refuse = () => {
  const error = new Error("Docker candidate refused an unowned transport/process/policy");
  Error.captureStackTrace(error, refuse);
  // Inspect the stack privately. Only an integer location in these exact source
  // bytes leaves the fixture; no raw frame, path or caller argument is exported.
  const prefix = `${import.meta.url}:`;
  let line = 0,
    column = 0;
  for (const frame of String(error.stack).split("\n").slice(1)) {
    const index = frame.indexOf(prefix);
    if (index < 0 || !/^\s*at /.test(frame)) continue;
    const match = /^(\d+):(\d+)\)?$/.exec(frame.slice(index + prefix.length));
    if (!match) continue;
    const row = Number(match[1]),
      position = Number(match[2]);
    if (
      row > 0 &&
      row <= diagnosticLines.length &&
      position > 0 &&
      position <= diagnosticLines[row - 1].length + 1
    ) {
      line = row;
      column = position;
      break;
    }
  }
  Object.defineProperty(error, "candidateGuardRefusal", {
    value: Object.freeze({
      version: 1,
      source: "docker-candidate-guard.mjs",
      sha256: diagnosticHash,
      line,
      column,
    }),
  });
  throw error;
};
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const marker = Symbol.for("codeshell.docker-candidate.pre-core");
const modulePath = fileURLToPath(import.meta.url);
// This digest identifies diagnostic coordinates only. candidateFile() still
// independently enforces every existing pathname/inode/hash authority check.
const diagnosticBytes = readFileSync(modulePath);
const diagnosticHash = candidateHash(diagnosticBytes);
const diagnosticLines = diagnosticBytes.toString("utf8").split("\n");
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
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > maximum) refuse();
    const buffer = Buffer.alloc(opened.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const count = readSync(fd, buffer, used, buffer.length - used, used);
      if (!count) break;
      used += count;
    }
    const bytes = buffer.subarray(0, used),
      after = fstatSync(fd),
      named = lstatSync(path);
    if (
      bytes.length > maximum ||
      [after, named].some(
        (value) =>
          !value.isFile() ||
          value.nlink !== 1 ||
          (privateFile && (value.mode & 0o077 || !owned(value))) ||
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

export function installDockerCandidateGuard(
  config,
  { dockerCommand, runtimeChild, driverChild, childStarted } = {},
) {
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
  const exactOrigin = (origin) => {
    const url = new URL(origin);
    if (
      url.origin !== origin ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      Number(url.port) < 1 ||
      !["http:", "https:"].includes(url.protocol)
    )
      refuse();
    return origin;
  };
  const allowOrigin = (origin) => origins.add(exactOrigin(origin));
  const revokeOrigin = (origin) => origins.delete(exactOrigin(origin));
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
    // The frozen Video renderer normally asks the OS for a random frame-server
    // port. This fixture maps only those exact entry bytes to one firewall port.
    const alias =
      options?.host === "127.0.0.1" && options.port === 0
        ? config.listenerAliases?.find(
            (value) =>
              value.host === "127.0.0.1" &&
              value.requestedPort === 0 &&
              value.port === 18794 &&
              /^[a-f0-9]{64}$/.test(value.entryHash) &&
              process.argv[1] &&
              candidateFile(realpathSync(process.argv[1])).sha256 === value.entryHash,
          )
        : undefined;
    if (
      !options ||
      options.path ||
      (!alias &&
        !(config.listeners ?? []).some(
          (value) => value.host === options.host && value.port === options.port,
        ))
    )
      refuse();
    if (alias) {
      if (typeof args[0] === "object") args[0] = { ...args[0], port: alias.port };
      else args[0] = alias.port;
    }
    this.once("listening", () => {
      if (options.host === "127.0.0.1")
        allowOrigin(
          `${this instanceof tls.Server ? "https" : "http"}://127.0.0.1:${this.address().port}`,
        );
      record("listener", {
        host: options.host,
        port: this.address().port,
        ...(alias ? { requestedPort: 0, aliasEntryHash: alias.entryHash } : {}),
      });
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
  // c-ares resolver methods bypass net/dgram JavaScript wrappers. Refuse the
  // complete callback/promise API and captured Resolver prototypes too.
  for (const surface of [
    dns,
    dns.promises,
    dns.Resolver.prototype,
    dns.promises.Resolver.prototype,
  ])
    for (const method of Object.getOwnPropertyNames(surface))
      if (/^resolve/.test(method) || ["reverse", "lookupService"].includes(method))
        surface[method] = refuse;
  dns.Resolver = dns.promises.Resolver = function () {
    refuse();
  };
  for (const method of ["bind", "connect", "send"]) dgram.Socket.prototype[method] = refuse;
  dgram.Socket = function () {
    refuse();
  };
  globalThis.WebSocket = function () {
    refuse();
  };
  dgram.createSocket = http2.connect = inspector.open = refuse;
  const originals = {
    spawn: children.spawn,
    execFile: children.execFile,
    nativeSpawn: children.ChildProcess.prototype.spawn,
  };
  let nativeSpawnAuthority;
  // Both Node exports eventually invoke the public ChildProcess prototype.
  // Give that one synchronous invocation an exact, single-use grant. Options
  // and environment getters are evaluated before the grant becomes available.
  const invokeNative = (method, command, args, options = {}, callback) => {
    if (nativeSpawnAuthority || !Array.isArray(args)) refuse();
    const actualArgs = [...args];
    const actualOptions = { ...options, env: { ...(options.env ?? process.env) } };
    if (actualOptions.shell) refuse();
    const grant = {
      file: command,
      args: [method === "spawn" ? (actualOptions.argv0 ?? command) : command, ...actualArgs],
      cwd: actualOptions.cwd ?? null,
      uid: actualOptions.uid ?? null,
      gid: actualOptions.gid ?? null,
      detached: method === "spawn" && !!actualOptions.detached,
      envPairs: Object.entries(actualOptions.env)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${value}`)
        .sort(),
    };
    nativeSpawnAuthority = grant;
    try {
      return originals[method](command, actualArgs, actualOptions, callback);
    } finally {
      nativeSpawnAuthority = undefined;
    }
  };
  children.ChildProcess.prototype.spawn = function (options) {
    const grant = nativeSpawnAuthority;
    if (
      !grant ||
      !options ||
      options.file !== grant.file ||
      !same(options.args, grant.args) ||
      !same(options.cwd ?? null, grant.cwd) ||
      (options.uid ?? null) !== grant.uid ||
      (options.gid ?? null) !== grant.gid ||
      !!options.detached !== grant.detached ||
      !Array.isArray(options.envPairs) ||
      !same([...options.envPairs].sort(), grant.envPairs)
    )
      refuse();
    // Consume before native callbacks/diagnostics can reenter the prototype.
    nativeSpawnAuthority = undefined;
    return originals.nativeSpawn.call(this, options);
  };
  const permitChild = (command, args, options = {}) => {
    if (!Array.isArray(args) || options.shell) refuse();
    let env = options.env ?? process.env;
    const descriptor =
      (config.children ?? []).find(
        (value) => (command === value.path || command === value.command) && same(value.args, args),
      ) ??
      runtimeChild?.(config, command, args, options) ??
      (role === "driver" ? driverChild?.(command, args, options) : undefined);
    if (!descriptor || (options.detached && !descriptor.allowDetached)) refuse();
    const expected = descriptor.environment ?? process.env;
    const childHome = descriptor.environment?.HOME ?? home;
    if (descriptor.environment?.HOME !== undefined) {
      if (
        typeof childHome !== "string" ||
        !isAbsolute(childHome) ||
        realpathSync(childHome) !== childHome
      )
        refuse();
      const directory = lstatSync(childHome);
      if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        (directory.mode & 0o777) !== 0o700 ||
        !owned(directory) ||
        expected.USERPROFILE !== childHome ||
        expected.CODE_SHELL_HOME !== `${childHome}/.code-shell`
      )
        refuse();
    }
    if (descriptor.reinject) {
      // The production Panel service intentionally strips Node options. Only
      // a reviewed, pinned child may receive this fixture's preload again.
      for (const key of [
        "NODE_OPTIONS",
        "CODE_SHELL_HOME",
        "CODESHELL_DOCKER_CANDIDATE_CONFIG",
        "CODESHELL_DOCKER_CANDIDATE_CONFIG_HASH",
      ])
        if (env[key] !== undefined && env[key] !== process.env[key]) refuse();
      env = {
        ...env,
        NODE_OPTIONS: process.env.NODE_OPTIONS,
        CODE_SHELL_HOME: process.env.CODE_SHELL_HOME,
        CODESHELL_DOCKER_CANDIDATE_CONFIG: process.env.CODESHELL_DOCKER_CANDIDATE_CONFIG,
        CODESHELL_DOCKER_CANDIDATE_CONFIG_HASH: process.env.CODESHELL_DOCKER_CANDIDATE_CONFIG_HASH,
        CODESHELL_DOCKER_CANDIDATE_CONTAINER: process.env.CODESHELL_DOCKER_CANDIDATE_CONTAINER,
      };
    }
    if (
      env.HOME !== childHome ||
      env.USERPROFILE !== childHome ||
      env.CODE_SHELL_HOME !== expected.CODE_SHELL_HOME ||
      env.NODE_OPTIONS !== expected.NODE_OPTIONS ||
      env.CODESHELL_DOCKER_CANDIDATE_CONFIG !== expected.CODESHELL_DOCKER_CANDIDATE_CONFIG ||
      env.CODESHELL_DOCKER_CANDIDATE_CONFIG_HASH !== expected.CODESHELL_DOCKER_CANDIDATE_CONFIG_HASH
    )
      refuse();
    if (
      !descriptor ||
      candidateFile(descriptor.path, { maximum: descriptor.maximum ?? 128 * 1024 * 1024 })
        .sha256 !== descriptor.sha256 ||
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
      childPolicyHash: env.CODESHELL_DOCKER_CANDIDATE_CONFIG_HASH,
      childArgvHash: candidateHash(JSON.stringify(args[0] === "-e" ? args.slice(2) : args)),
      argvHash: candidateHash(JSON.stringify(args)),
    });
    return {
      command: descriptor.path,
      args,
      isNode: descriptor.path === realpathSync(process.execPath),
      childRole: descriptor.role,
      childPolicyHash: env.CODESHELL_DOCKER_CANDIDATE_CONFIG_HASH,
      childArgvHash: candidateHash(JSON.stringify(args[0] === "-e" ? args.slice(2) : args)),
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
          original: (command, args, options, callback) =>
            invokeNative("execFile", command, args, options, callback),
          allowOrigin,
          record,
        });
      const allowed = permitChild(command, args, options);
      const child = invokeNative(method, allowed.command, allowed.args, allowed.options, callback);
      childStarted?.(child);
      record("child-started", {
        childPid: child.pid,
        isNode: allowed.isNode,
        childRole: allowed.childRole,
        childPolicyHash: allowed.childPolicyHash,
        argvHash: allowed.childArgvHash,
      });
      child.once("close", (code, signal) =>
        record("child-closed", { childPid: child.pid, code, signal }),
      );
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
  // Worker isolates have fresh builtins and can discard NODE_OPTIONS through
  // their own execArgv/env. All reviewed Core workers are pinned Node children;
  // no Worker constructor is part of this fixture's process authority.
  workers.Worker = function () {
    refuse();
  };
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
  const dnsProbes = [
    () => dns.resolveTxt("external.invalid"),
    () => dns.promises.resolveAny("external.invalid"),
    () => new dns.Resolver(),
    () => new dns.promises.Resolver(),
  ];
  for (const probe of dnsProbes) assert.throws(probe, /Docker candidate refused/);
  globalThis[marker] = Object.freeze({
    role,
    negativeProbes: probes.length,
    dnsNegativeProbes: dnsProbes.length,
  });
  record("pre-core", {
    negativeProbes: probes.length,
    dnsNegativeProbes: dnsProbes.length,
    argvHash: candidateHash(JSON.stringify(process.argv.slice(1))),
  });
  return { allowOrigin, revokeOrigin, record };
}
