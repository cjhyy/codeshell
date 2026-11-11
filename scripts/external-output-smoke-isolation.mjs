// Test-only Node preload. It runs before any Core/host import, including fake CLIs.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { appendFileSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
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
    record("blocked");
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
  // Match Core's bounded APFS UUID lookup, using the same binary and volume
  // pinning as the mobile external-output fixture. No other command is allowed.
  const fixtureRoot = process.env.CODESHELL_OUTPUT_ROOT;
  const diskOptions = {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 256 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
  };
  const exactKeys = (value, keys) => {
    if (!value || typeof value !== "object") return false;
    const prototype = Object.getPrototypeOf(value);
    const ownKeys = Reflect.ownKeys(value);
    return (
      (prototype === Object.prototype || prototype === null) &&
      ownKeys.length === keys.length &&
      ownKeys.every((key) => keys.includes(key))
    );
  };
  const checkDiskInfo = (command, args, options) => {
    if (process.platform !== "darwin" || command !== "/usr/sbin/diskutil") return false;
    const env = options?.env ?? {};
    const devicePath = args?.[2];
    if (
      !exactKeys(options, Object.keys(diskOptions)) ||
      !exactKeys(env, Object.keys(diskOptions.env)) ||
      !Array.isArray(args) ||
      args.length !== 3 ||
      args[0] !== "info" ||
      args[1] !== "-plist" ||
      typeof devicePath !== "string" ||
      !/^\/dev\/disk[0-9]+(?:s[0-9]+)*$/.test(devicePath) ||
      !process.env.CODESHELL_OUTPUT_DISKUTIL_HASH ||
      realpathSync(command) !== process.env.CODESHELL_OUTPUT_DISKUTIL ||
      hashFile(command) !== process.env.CODESHELL_OUTPUT_DISKUTIL_HASH ||
      options.encoding !== diskOptions.encoding ||
      options.timeout !== diskOptions.timeout ||
      options.maxBuffer !== diskOptions.maxBuffer ||
      JSON.stringify(options.stdio) !== JSON.stringify(diskOptions.stdio) ||
      env.PATH !== diskOptions.env.PATH ||
      env.LANG !== "C" ||
      env.LC_ALL !== "C"
    )
      deny();
    const rootInfo = lstatSync(fixtureRoot);
    const device = lstatSync(devicePath);
    if (
      !rootInfo.isDirectory() ||
      rootInfo.isSymbolicLink() ||
      realpathSync(fixtureRoot) !== fixtureRoot ||
      !home.startsWith(`${fixtureRoot}/`) ||
      !device.isBlockDevice() ||
      device.rdev !== rootInfo.dev
    )
      deny();
    record("allowed-volume-metadata");
    return devicePath;
  };
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = function (command, args = [], options = {}) {
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
  const originalExecFileSync = childProcess.execFileSync;
  childProcess.execFileSync = function (command, args = [], options = {}) {
    const device = checkDiskInfo(command, args, options);
    if (!device) deny();
    // Do not forward caller objects: inherited options/getters must never turn
    // a metadata lookup into a shell, alternate environment, or different IO.
    return originalExecFileSync.call(this, command, ["info", "-plist", device], {
      __proto__: null,
      ...diskOptions,
      stdio: [...diskOptions.stdio],
      env: { __proto__: null, ...diskOptions.env },
    });
  };
  for (const name of ["spawnSync", "exec", "execSync", "execFile", "fork"])
    childProcess[name] = deny;
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
  const fixtureDevice =
    process.platform === "darwin"
      ? readdirSync("/dev")
          .filter((name) => /^disk[0-9]+(?:s[0-9]+)*$/.test(name))
          .map((name) => `/dev/${name}`)
          .find((path) => {
            const info = lstatSync(path);
            return info.isBlockDevice() && info.rdev === lstatSync(fixtureRoot).dev;
          })
      : "/dev/disk0";
  if (!fixtureDevice) throw new Error("Fixture volume has no block device");
  const inheritedOptions = Object.assign(Object.create({ env: diskOptions.env }), {
    encoding: diskOptions.encoding,
    timeout: diskOptions.timeout,
    maxBuffer: diskOptions.maxBuffer,
    stdio: diskOptions.stdio,
    shell: "/bin/sh",
  });
  const probes = [
    () => globalThis.fetch("https://example.invalid/"),
    () => http.get("http://127.0.0.1:1/"),
    () => net.connect({ host: "127.0.0.1", port: 2 }),
    () => childProcess.spawn("sh", ["-c", "exit 0"]),
    () => childProcess.execFileSync("/usr/sbin/diskutil", ["list", "-plist"], diskOptions),
    () =>
      childProcess.execFileSync("/usr/sbin/diskutil", ["info", "-plist", "/dev/disk0"], {
        ...diskOptions,
        shell: true,
      }),
    () => childProcess.execFileSync("/usr/sbin/diskutil", ["info", "-plist", home], diskOptions),
    () =>
      childProcess.execFileSync("/usr/sbin/diskutil", ["info", "-plist", "/dev/disk0"], {
        ...diskOptions,
        env: { ...diskOptions.env, INJECTED: "refuse" },
      }),
    () =>
      childProcess.execFileSync(
        "/usr/sbin/diskutil",
        ["info", "-plist", fixtureDevice],
        inheritedOptions,
      ),
    () =>
      childProcess.execFileSync("/usr/sbin/diskutil", ["info", "-plist", fixtureDevice], {
        ...diskOptions,
        env: Object.assign(Object.create({ INJECTED: "refuse" }), diskOptions.env),
      }),
  ];
  for (const probe of probes) {
    try {
      probe();
    } catch {
      refused++;
    }
  }
  if (refused !== probes.length)
    throw new Error("External output confinement negative probe failed");
  record("pre-core", {
    negativeProbes: refused,
    nodeVersion: process.versions.node,
    execPath: process.execPath,
    nodeBinaryHash: hashFile(process.execPath),
  });
}
if (process.env.CODESHELL_OUTPUT_HOME_HASH) installExternalOutputGuard();
