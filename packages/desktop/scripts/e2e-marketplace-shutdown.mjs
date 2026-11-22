import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, readdir, rmdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareConfinedElectronFixture } from "./confined-electron-fixture.mjs";
import {
  launchCodeShellElectron,
  makeIsolatedElectronHome,
  seedOfflinePluginBootstrap,
} from "./electron-harness.mjs";

assert(
  process.env.CODE_SHELL_TEST_HOME &&
    process.env.CODE_SHELL_HOME === process.env.CODE_SHELL_TEST_HOME,
  "Use the isolated Node smoke runner",
);
const appDir = fileURLToPath(new URL("../", import.meta.url));
const isolated = await makeIsolatedElectronHome("codeshell-marketplace-quit-");
const plugins = join(isolated.codeShellHome, "plugins");
const markets = join(plugins, "marketplaces");
const registry = join(plugins, "known_marketplaces.json");
const trace = join(isolated.home, "git-trace.jsonl");
const receipt = join(isolated.home, "host-close.jsonl");
const config = join(isolated.home, ".gitconfig");
const heldLock = markets + ".lock";
const lockReceipt = join(isolated.home, "publish-lock-wait.json");
const spawnedHosts = join(isolated.home, "spawned-hosts.jsonl");
const gitEnv = {
  ...process.env,
  HOME: isolated.home,
  USERPROFILE: isolated.home,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: config,
  GIT_ALLOW_PROTOCOL: "file:http",
  NO_PROXY: "127.0.0.1",
};
const git = (...args) =>
  execFileSync("git", args, { cwd: isolated.home, env: gitEnv, stdio: "pipe" });
const rows = async (file) =>
  (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
async function waitFor(check, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(25);
  }
  throw Error(message);
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};
let application, socket, requested;
const server = createServer((req) => {
  socket = req.socket;
  requested = req.url;
});
const portReady = once(server, "listening");
server.listen(0, "127.0.0.1");
try {
  await portReady;
  const origin = "http://127.0.0.1:" + server.address().port;
  const source = "https://github.com/obra/superpowers-marketplace.git";
  const rewrite = "url." + origin + "/owned.git.insteadOf";
  git("config", "--file", config, rewrite, source);
  git("config", "--file", config, "http.proxy", "");
  git("config", "--file", config, "trace2.eventTarget", trace);
  await seedOfflinePluginBootstrap(isolated.codeShellHome);
  const known = JSON.parse(await readFile(registry, "utf8"));
  delete known.official;
  await writeFile(registry, JSON.stringify(known));

  const guard = join(isolated.home, "exit-receipt.mjs");
  const networkGuard = new URL("../../../scripts/runtime-cost-smoke-isolation.mjs", import.meta.url)
    .href;
  await writeFile(
    guard,
    [
      "import " + JSON.stringify(networkGuard) + ";",
      'import { appendFileSync } from "node:fs"; import { isMainThread } from "node:worker_threads";',
      "import { observeMarketplaceWorker } from " +
        JSON.stringify(new URL("./marketplace-lock-witness.mjs", import.meta.url).href) +
        ";",
      "if (isMainThread && process.parentPort) {",
      "  observeMarketplaceWorker(" +
        [pathToFileURL(join(appDir, "out/main/marketplace-worker.mjs")).href, heldLock, lockReceipt]
          .map((value) => JSON.stringify(value))
          .join(", ") +
        ");",
      "  const record = (kind, code) => appendFileSync(" +
        JSON.stringify(receipt) +
        ', JSON.stringify({ kind, code, pid: process.pid, time: Date.now() }) + "\\n");',
      '  process.parentPort.on("message", ({ data }) => { if (data?.type === "shutdown") record("shutdown"); });',
      '  process.on("exit", (code) => record("exit", code));',
      "}",
    ].join("\n"),
  );
  const fixture = await prepareConfinedElectronFixture({
    appDir,
    isolated,
    origin,
    guardModule: pathToFileURL(guard).href,
  });
  const launch = () =>
    launchCodeShellElectron({
      appDir,
      ...isolated,
      mainEntry: fixture.mainEntry,
      env: {
        ...fixture.env,
        GIT_CONFIG_GLOBAL: config,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_ALLOW_PROTOCOL: "file:http",
        NO_PROXY: "127.0.0.1",
        CODESHELL_E2E_MOCK_KEYCHAIN: "1",
      },
    });
  async function quit() {
    const exited = once(application.process(), "exit", { signal: AbortSignal.timeout(12000) });
    await application.evaluate(({ app }) => {
      setImmediate(() => app.quit());
    });
    const [code, signal] = await exited;
    assert.equal(signal, null);
    assert.equal(code, 0);
    application = undefined;
  }
  application = await launch();
  await waitFor(() => requested, "The first-run clone did not reach the owned server");
  assert.match(requested, /^\/owned\.git\/info\/refs\?service=git-upload-pack$/);
  const starts = (await rows(trace)).filter((event) => event.event === "start");
  const pidOf = (event) => parseInt(event.sid.match(/-P([a-f\d]+)$/i)[1], 16);
  const leader = starts.find((event) => event.argv.includes("clone"));
  const helper = starts.find((event) =>
    event.argv.some((arg) => /(?:^|[\\/])(?:git-)?remote-http(?:\.exe)?$/.test(arg)),
  );
  assert(leader && helper, "Git must start both clone and its real HTTP helper");
  const pids = [...new Set(starts.map(pidOf))];
  assert(pids.length >= 2 && pids.every(alive));
  const pgid =
    process.platform === "win32"
      ? undefined
      : Number(
          execFileSync("ps", ["-o", "pgid=", "-p", String(pidOf(helper))], { encoding: "utf8" }),
        );
  if (pgid !== undefined) assert.equal(pgid, pidOf(leader));
  assert((await readdir(markets)).some((name) => name.startsWith(".publish-")));
  await quit();
  assert(
    pids.every((pid) => !alive(pid)),
    "The Git processes must have exited when Main exits",
  );
  if (pgid !== undefined) assert.equal(alive(-pgid), false);
  await waitFor(() => socket.destroyed, "The HTTP helper kept its connection", 500);
  const events = await rows(receipt);
  assert.deepEqual(
    events.map((row) => row.kind),
    ["shutdown", "exit"],
  );
  assert.equal(events[1].pid, events[0].pid);
  assert.equal(events[1].code, 0);
  const hostDrainMs = events[1].time - events[0].time;
  assert(hostDrainMs < 2000, "Host must exit before the existing supervisor watchdog");
  assert.deepEqual(await readdir(markets), []);
  assert.deepEqual(JSON.parse(await readFile(registry, "utf8")), known);

  // The next launch retries the interrupted seed using a real local repository.
  const repo = join(isolated.home, "fixture-repository");
  await mkdir(join(repo, ".claude-plugin"), { recursive: true });
  const manifest = { name: "official", owner: { name: "Fixture" }, plugins: [] };
  await writeFile(join(repo, ".claude-plugin", "marketplace.json"), JSON.stringify(manifest));
  git("-C", repo, "init", "--template=");
  git("-C", repo, "add", ".");
  git(
    "-C",
    repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "Local marketplace",
  );
  git("config", "--file", config, "--unset", rewrite);
  git("config", "--file", config, "url." + pathToFileURL(repo).href + ".insteadOf", source);
  // Simulate a second process holding the publish lock. Quit must interrupt
  // only this worker's wait and remove only its private staging directory.
  await mkdir(heldLock);
  application = await launch();
  const witness = await waitFor(
    () =>
      readFile(lockReceipt, "utf8")
        .then(JSON.parse)
        .catch((error) => {
          if (error.code === "ENOENT" || error instanceof SyntaxError) return false;
          throw error;
        }),
    "Local retry did not encounter the held publish lock",
  );
  const [firstHost, lockedHost, ...others] = await rows(spawnedHosts);
  assert(firstHost && lockedHost && others.length === 0);
  assert.equal(firstHost.pid, events[0].pid);
  assert.equal(lockedHost.ppid, application.process().pid);
  assert.equal(witness.pid, lockedHost.pid);
  assert(witness.threadId > 0);
  await quit();
  const lockedQuit = (await rows(receipt)).slice(events.length);
  assert.deepEqual(
    lockedQuit.map(({ kind }) => kind),
    ["shutdown", "exit"],
  );
  assert(lockedQuit.every((row) => row.pid === lockedHost.pid));
  assert.equal(lockedQuit[1].code, 0);
  const lockDrainMs = lockedQuit[1].time - lockedQuit[0].time;
  assert(lockDrainMs < 2000);
  assert.deepEqual(await readdir(markets), []);
  assert.deepEqual(JSON.parse(await readFile(registry, "utf8")), known);
  await rmdir(heldLock);

  application = await launch();
  await waitFor(
    async () => JSON.parse(await readFile(registry, "utf8")).official,
    "Interrupted first-run install did not recover",
  );
  await quit();
  assert.deepEqual(
    JSON.parse(
      await readFile(join(markets, "official", ".claude-plugin", "marketplace.json"), "utf8"),
    ),
    manifest,
  );
  assert.deepEqual(await readdir(markets), ["official"]);
  assert(!(await readdir(plugins)).some((entry) => entry.endsWith(".lock")));
  console.log(
    JSON.stringify({
      hostDrainMs,
      lockDrainMs,
      lockedHostPid: witness.pid,
      hostPid: events[0].pid,
      gitPids: pids,
      processGroup: pgid,
      recovered: true,
    }),
  );
} finally {
  socket?.destroy();
  server.closeAllConnections();
  server.close();
  try {
    await application?.close();
  } finally {
    await isolated.cleanup();
  }
}
