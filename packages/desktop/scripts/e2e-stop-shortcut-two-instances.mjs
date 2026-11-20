/*
 * Two CodeShell instances and one ⌘⇧Esc. macOS reports success to every
 * process that registers the same global accelerator, so instances claim the
 * stop shortcut through a per-user owner file; the one that does not hold it
 * reports `shortcutUnavailable`, so Settings points to the Stop button.
 *
 * Opt-in (not part of `test:e2e`). Two isolated apps (own HOME, CODE_SHELL_HOME
 * and user-data dir each), stand-in helper bundles and stand-in `claude` CLIs.
 * The shortcut stays virtual (CODESHELL_E2E_STOP_SHORTCUT=virtual): no key is
 * taken from an installed CodeShell, and virtual owners use their own claim
 * file, so a real instance is never made to give up its key by this run.
 *
 * Covers: one owner while both have a live computer-use connection; release on
 * disconnect and takeover by the other; a claim left by a killed instance is
 * recovered; release on quit.
 */
/* global window */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import {
  ACCEPTANCE_MOCK_KEYCHAIN_ENV,
  assert,
  captureRendererErrors,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
  seedOfflinePluginBootstrap,
} from "./electron-harness.mjs";
import { installComputerUseStandIn } from "./computer-use-stand-in.mjs";
import { installExternalCliFixture } from "./external-cli-fixture.mjs";
import * as kit from "./external-computer-use-acceptance-kit.mjs";

process.env[ACCEPTANCE_MOCK_KEYCHAIN_ENV] = "1";
assert(process.platform === "darwin", "The stop shortcut is registered on macOS only");

const execFile = promisify(execFileCallback);
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The claim file virtual (acceptance) owners share; see stop-shortcut-lock.ts.
const CLAIM = join(
  tmpdir(),
  `code-shell-${userInfo().uid}`,
  "stop-shortcut.e2e-virtual.owner.json",
);
const { waitFor, pause } = kit;
const instances = [];

const claim = async () => {
  try {
    return JSON.parse(await readFile(CLAIM, "utf8"));
  } catch {
    return undefined;
  }
};

async function start(name) {
  const isolated = await makeIsolatedElectronHome(`codeshell-stop-shortcut-${name}-`);
  const instance = { name, isolated, turns: 0 };
  instances.push(instance);
  instance.cli = await installExternalCliFixture(join(isolated.home, "external-cli"));
  const standIn = await installComputerUseStandIn(join(isolated.home, "computer-use"));
  const projectPath = join(isolated.home, "acceptance-project");
  await mkdir(projectPath, { recursive: true });
  await mkdir(isolated.codeShellHome, { recursive: true });
  await writeFile(
    join(isolated.codeShellHome, "settings.json"),
    JSON.stringify({ autoUpdates: false, featureFlags: { computer_use_cua: true } }),
  );
  await seedOfflinePluginBootstrap(isolated.codeShellHome);
  instance.app = await launchCodeShellElectron({
    appDir,
    home: isolated.home,
    userDataDir: isolated.userDataDir,
    env: {
      PATH: instance.cli.bin + ":" + process.env.PATH,
      CODE_SHELL_EXTERNAL_CLI_DIR: instance.cli.bin,
      CODESHELL_E2E_COMPUTER_USE_BUNDLE: standIn.bundle,
      CODESHELL_E2E_STOP_SHORTCUT: "virtual",
    },
  });
  instance.win = await findCodeShellWindow(instance.app);
  await instance.win.setViewportSize({ width: 1360, height: 860 });
  instance.errors = captureRendererErrors(instance.win);
  instance.pid = await instance.app.evaluate(() => process.pid);
  await kit.muteStopNotice(instance.app);
  await kit.dismissTrust(instance.win);
  await kit.registerProject(instance.app, instance.win, projectPath);
  await kit.dismissTrust(instance.win);
  await kit.selectModel(instance.win, "claude-code/sonnet");
  await instance.win.getByRole("button", { name: /默认权限|Default/ }).click();
  await instance.win.getByRole("option", { name: /完全访问权限|Full access/ }).click();
  return instance;
}

const status = async (instance) =>
  (await instance.win.evaluate(() => window.codeshell.computerUse.status())).input;

/** A turn that keeps its computer-use connection open until Stop. */
async function hold(instance) {
  const calls = (await instance.cli.computerCalls()).length;
  await instance.cli.script([
    // An (empty) afterSignal makes the stand-in record the turn when stopped.
    { computer: [{ name: "list_apps" }], holdMs: 120_000, afterSignal: [], text: "held" },
  ]);
  await kit.send(instance.win, "hold the computer-use connection");
  instance.turns += 1;
  await waitFor(
    async () => (await instance.cli.computerCalls()).length > calls,
    `${instance.name}'s held call`,
  );
}

async function stopTurn(instance) {
  await instance.win.getByRole("button", { name: /^(停止|Stop)$/ }).click();
  await kit.claudeTurn(instance.win, instance.cli, instance.turns);
}

const owns = async (instance) =>
  (await kit.stopShortcutRegistered(instance.app)) &&
  (await status(instance)).shortcutUnavailable === false &&
  (await claim())?.pid === instance.pid;
const refused = async (instance) =>
  !(await kit.stopShortcutRegistered(instance.app)) &&
  (await status(instance)).shortcutUnavailable === true;

try {
  const stale = await claim();
  assert(
    !stale ||
      !(await execFile("/bin/kill", ["-0", String(stale.pid)]).then(
        () => true,
        () => false,
      )),
    `A live process already holds the virtual claim (${JSON.stringify(stale)}); another acceptance run?`,
  );
  const a = await start("a");
  const b = await start("b");
  console.log(`acceptance: two isolated instances up (a=${a.pid}, b=${b.pid})`);

  await hold(a);
  await waitFor(() => owns(a), "a to own the stop shortcut");
  await hold(b);
  await waitFor(() => refused(b), "b to report the shortcut unavailable");
  assert(await owns(a), "a lost the shortcut when b connected");
  console.log("acceptance: a owns ⌘⇧Esc; b reports shortcutUnavailable (Settings shows Stop)");

  // a's connection ends: it releases; b takes over on its next connection.
  await stopTurn(a);
  await waitFor(
    async () => !(await kit.stopShortcutRegistered(a.app)) && !(await claim()),
    "a to release the claim on disconnect",
  );
  await stopTurn(b);
  await waitFor(
    async () => (await status(b)).shortcutUnavailable === false,
    "b's warning to clear",
  );
  await hold(b);
  await waitFor(() => owns(b), "b to take the shortcut over");
  console.log("acceptance: a released on disconnect; b's next connection took the shortcut");

  // b dies holding it: its claim is stale and a recovers it.
  process.kill(b.pid, "SIGKILL");
  await waitFor(
    async () =>
      !(await execFile("/bin/kill", ["-0", String(b.pid)]).then(
        () => true,
        () => false,
      )),
    "the killed instance to exit",
  );
  assert((await claim())?.pid === b.pid, "the killed instance's claim was not left behind");
  await hold(a);
  await waitFor(() => owns(a), "a to recover the dead instance's claim");
  console.log("acceptance: a recovered the claim a killed instance left behind");

  // Quitting while connected releases the claim.
  const aPid = a.pid;
  await a.app.close();
  a.app = undefined;
  assert((await claim())?.pid !== aPid, "quitting did not release the claim");
  console.log("acceptance: quitting released the claim");

  for (const instance of instances)
    assert(
      instance.errors.length === 0 || instance === b,
      `Renderer errors in ${instance.name}: ${instance.errors.map((e) => e.message).join("; ")}`,
    );
  console.log("CodeShell stop shortcut two-instance acceptance: passed");
} finally {
  for (const instance of instances) {
    await instance.app?.close().catch(() => undefined);
    // A SIGKILLed app leaves its children (stand-in helper, fixture CLI) behind.
    const left = (
      await execFile("/usr/bin/pgrep", ["-f", instance.isolated.home]).catch(() => ({ stdout: "" }))
    ).stdout
      .split("\n")
      .filter(Boolean)
      .map(Number);
    for (const pid of left) process.kill(pid, "SIGTERM");
    for (let i = 0; i < 50; i++) {
      const still = (
        await execFile("/usr/bin/pgrep", ["-f", instance.isolated.home]).catch(() => ({
          stdout: "",
        }))
      ).stdout.trim();
      if (!still) break;
      await pause(100);
    }
    await instance.isolated.cleanup();
  }
}
