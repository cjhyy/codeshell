import assert from "node:assert/strict";
import childProcess from "node:child_process";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import workerThreads from "node:worker_threads";
import { syncBuiltinESMExports } from "node:module";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { devNull } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [source, root] = process.argv.slice(2);
assert.ok(["path", "git", "git-subdir"].includes(source));
assert.equal(realpathSync(root), root);
const home = join(root, "home");
assert.equal(process.env.HOME, home);
assert.equal(realpathSync(home), home);
if (process.platform !== "win32") assert.equal(statSync(home).mode & 0o777, 0o700);
if (process.getuid) assert.equal(statSync(home).uid, process.getuid());
process.chdir(home);
const git = process.env.FIXTURE_GIT_BINARY;
const gitHash = process.env.FIXTURE_GIT_SHA256;
assert.equal(realpathSync(git), git);
const gitPin = lstatSync(git, { bigint: true });
assert.ok(gitPin.isFile());
function verifyGit() {
  const current = lstatSync(git, { bigint: true });
  assert.equal(current.dev, gitPin.dev);
  assert.equal(current.ino, gitPin.ino);
  assert.equal(createHash("sha256").update(readFileSync(git)).digest("hex"), gitHash);
}
Object.assign(process.env, {
  PATH: dirname(git),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: devNull,
  GIT_ALLOW_PROTOCOL: "file",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_VALUE_0: devNull,
});
function setupGit(args) {
  verifyGit();
  const result = childProcess.spawnSync(git, args, {
    env: process.env,
    cwd: home,
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  verifyGit();
}
const content = "Owned ordinary target; no plugin instruction or hook execution.\n";
const pluginFiles = {
  ".claude-plugin/plugin.json": JSON.stringify({ name: "fixture", version: "1.0.0" }),
  "CLAUDE.md": content,
  "hooks/hooks.json": JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "must-never-execute" }] }] },
  }),
};
function bareRepository(name, files, alias) {
  const work = join(home, `${name}-work`);
  mkdirSync(work, { mode: 0o700 });
  setupGit(["init", "-q", work]);
  setupGit(["-C", work, "config", "user.email", "fixture@example.invalid"]);
  setupGit(["-C", work, "config", "user.name", "Fixture"]);
  for (const [path, bytes] of Object.entries(files)) {
    const destination = join(work, path);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, bytes);
  }
  // Exact upstream superpowers@d884 AGENTS.md blob681311… is the nine bytes CLAUDE.md.
  if (alias) symlinkSync("CLAUDE.md", join(work, alias));
  setupGit(["-C", work, "add", "."]);
  setupGit(["-C", work, "commit", "-q", "-m", "fixture"]);
  const bare = join(home, `${name}.git`);
  setupGit(["clone", "--bare", "-q", work, bare]);
  rmSync(work, { recursive: true });
  return bare;
}
const prefix = source === "git-subdir" ? "plugins/fixture/" : "";
const pluginRepo =
  source === "path"
    ? undefined
    : bareRepository(
        "plugin",
        Object.fromEntries(
          Object.entries(pluginFiles).map(([path, bytes]) => [prefix + path, bytes]),
        ),
        prefix + "AGENTS.md",
      );
const entrySource =
  source === "path"
    ? "./plugins/fixture"
    : source === "git"
      ? { source: "git", url: pluginRepo }
      : { source: "git-subdir", url: pluginRepo, path: "plugins/fixture" };
const marketFiles = {
  ".claude-plugin/marketplace.json": JSON.stringify({
    name: "fixture-market",
    owner: { name: "Fixture" },
    plugins: [{ name: "fixture", source: entrySource }],
  }),
  ...(source === "path"
    ? Object.fromEntries(
        Object.entries(pluginFiles).map(([path, bytes]) => [`plugins/fixture/${path}`, bytes]),
      )
    : {}),
};
const marketRepo = bareRepository(
  "market",
  marketFiles,
  source === "path" ? "plugins/fixture/AGENTS.md" : undefined,
);

const ownedRepos = new Set([marketRepo, ...(pluginRepo ? [pluginRepo] : [])]);
const clones = new Set();
const children = [];
function refuse() {
  throw new Error("Plugin installer fixture refused transport/process");
}
function owned(path) {
  const rel = relative(home, resolve(path));
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(rel)
  );
}
function checkGit(file, args, cwd, env) {
  verifyGit();
  if (
    (file !== git && file !== "git") ||
    env.HOME !== home ||
    env.PATH !== dirname(git) ||
    env.GIT_ALLOW_PROTOCOL !== "file" ||
    env.GIT_CONFIG_GLOBAL !== devNull ||
    env.GIT_CONFIG_COUNT !== "1" ||
    env.GIT_CONFIG_KEY_0 !== "core.hooksPath" ||
    env.GIT_CONFIG_VALUE_0 !== devNull
  )
    refuse();
  if (args[0] === "clone") {
    if (
      JSON.stringify(args.slice(0, 6)) !==
        JSON.stringify(["clone", "--depth", "1", "--filter=blob:none", "--no-checkout", "--"]) ||
      args.length !== 8 ||
      !ownedRepos.has(args[6]) ||
      !owned(args[7]) ||
      cwd !== home
    )
      refuse();
    clones.add(args[7]);
    return;
  }
  if (!clones.has(cwd)) refuse();
  const allowed = [
    ["checkout"],
    ["rev-parse", "HEAD"],
    ["sparse-checkout", "set", "--no-cone", "--", ".claude-plugin", ".agents/plugins"],
    ["sparse-checkout", "add", "--", "plugins/fixture"],
  ];
  if (!allowed.some((candidate) => JSON.stringify(candidate) === JSON.stringify(args))) refuse();
}
const spawn = childProcess.spawn;
childProcess.spawn = function (file, args, options) {
  checkGit(file, args, options?.cwd, options?.env ?? {});
  const child = spawn.call(this, file, args, options);
  const record = { pid: child.pid, closed: false };
  record.completion = new Promise((resolveClose) =>
    child.once("close", () => {
      record.closed = true;
      resolveClose();
    }),
  );
  children.push(record);
  return child;
};
const nativeSpawn = childProcess.ChildProcess.prototype.spawn;
childProcess.ChildProcess.prototype.spawn = function (options) {
  const env = Object.fromEntries(
    options.envPairs.map((pair) => {
      const at = pair.indexOf("=");
      return [pair.slice(0, at), pair.slice(at + 1)];
    }),
  );
  checkGit(options.file, options.args.slice(1), options.cwd, env);
  return nativeSpawn.call(this, options);
};
for (const name of ["spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])
  childProcess[name] = refuse;
for (const module of [http, https]) for (const name of ["request", "get"]) module[name] = refuse;
net.Socket.prototype.connect = refuse;
net.Server.prototype.listen = refuse;
tls.connect = refuse;
dgram.createSocket = refuse;
globalThis.fetch = refuse;
workerThreads.Worker = refuse;
for (const target of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
  for (const name of Object.getOwnPropertyNames(target))
    if (/^(lookup|lookupService|resolve|reverse)/.test(name) && typeof target[name] === "function")
      target[name] = refuse;
}
syncBuiltinESMExports();
let negativeProbes = 0;
for (const probe of [
  () => fetch("https://external.invalid"),
  () => http.get("http://127.0.0.1:1"),
  () => https.get("https://external.invalid"),
  () => new net.Socket().connect(1, "127.0.0.1"),
  () => dns.lookup("external.invalid"),
  () => dns.promises.resolveAny("external.invalid"),
  () => childProcess.spawn("sh", [], {}),
  () => new workerThreads.Worker("throw 1", { eval: true }),
]) {
  assert.throws(probe, /fixture refused/);
  negativeProbes++;
}

let failure;
let failed = false;
let result = {};
try {
  const pins = JSON.parse(readFileSync(join(root, "entries.json"), "utf8"));
  for (const name of ["pluginInstaller.mjs", "marketplaceManager.mjs"])
    assert.equal(
      createHash("sha256")
        .update(readFileSync(join(root, name)))
        .digest("hex"),
      pins[name],
    );
  const { addMarketplace, marketplaceDir } = await import(
    pathToFileURL(join(root, "marketplaceManager.mjs")).href
  );
  const { installPlugin } = await import(pathToFileURL(join(root, "pluginInstaller.mjs")).href);
  const added = await addMarketplace("fixture-market", { source: "git", url: marketRepo });
  assert.equal(added.ok, true, added.error);
  const installed = await installPlugin("fixture", "fixture-market");
  assert.equal(installed.ok, true, installed.error);
  const path = installed.entry.installPath;
  assert.equal(lstatSync(join(path, "AGENTS.md")).isSymbolicLink(), true);
  const aliasText = readlinkSync(join(path, "AGENTS.md"));
  assert.equal(aliasText, "CLAUDE.md");
  assert.equal(realpathSync(join(path, "AGENTS.md")), join(path, "CLAUDE.md"));
  assert.equal(readFileSync(join(path, "AGENTS.md"), "utf8"), content);
  assert.match(installed.entry.hookDigest, /^[a-f0-9]{64}$/);
  assert.equal(installed.entry.approvedHookDigest, undefined);
  rmSync(marketplaceDir("fixture-market"), { recursive: true });
  rmSync(marketRepo, { recursive: true });
  if (pluginRepo) rmSync(pluginRepo, { recursive: true });
  assert.equal(readFileSync(join(path, "AGENTS.md"), "utf8"), content);
  result = { aliasText, selfContainedAfterSourceRemoval: true, hookApprovalUnchanged: true };
} catch (error) {
  failed = true;
  failure = error;
} finally {
  await Promise.race([
    Promise.all(children.map((child) => child.completion)),
    new Promise((resolveWait) => setTimeout(resolveWait, 5_000).unref()),
  ]);
  if (children.some((child) => !child.closed)) {
    failed = true;
    failure ??= new Error("Owned Git child did not close");
  }
  console.log(
    JSON.stringify({
      source,
      passed: !failed,
      node: process.version,
      ...result,
      negativeProbes,
      gitChildren: children.map(({ pid, closed }) => ({ pid, closed })),
      ownedGitChildrenClosed: children.every((child) => child.closed),
      ...(failed
        ? { failure: failure instanceof Error ? failure.message : "Non-Error fixture failure" }
        : {}),
    }),
  );
}
if (failed) process.exitCode = 1;
