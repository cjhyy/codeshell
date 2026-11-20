/*
 * Real-driver acceptance for Computer Use in an external-runtime (Claude Code)
 * session: the isolated app drives a REAL "CodeShell Computer Use.app" and its
 * cua-driver against one Calculator instance this script starts and quits.
 *
 * THIS ACTS ON THE DESKTOP IT RUNS ON. It is not part of any test chain and
 * refuses to start unless both are set:
 *
 *   CODESHELL_E2E_REAL_COMPUTER_USE=act-on-my-desktop
 *   CODESHELL_E2E_REAL_COMPUTER_USE_BUNDLE=/abs/path/CodeShell Computer Use.app
 *
 * The bundle must be one macOS already trusts for Accessibility (for example
 * the helper inside an installed CodeShell). A freshly built helper is ad-hoc
 * signed and is refused here: starting it could make macOS ask for permission.
 *
 * What keeps it harmless:
 * - Before anything starts: the bundle's signature is checked, the driver
 *   version must be the pinned one, and the helper's own passive status read
 *   (AXIsProcessTrusted, never the prompting variant) must say "granted".
 * - Only element-addressed accessibility actions are sent, always to the
 *   Calculator pid started here. No pixel click, no typing, no hotkey, no
 *   foreground delivery, no launch through the driver, and no screenshot
 *   (`include_screenshot:false`: a capture can raise macOS's own periodic
 *   screen-recording confirmation).
 * - A click's target is resolved from the tree read in the same turn and is
 *   sent only when exactly one button has that label.
 * - The user-activity clock is the machine's real one; nothing fakes idleness.
 * - The ⌘⇧Esc stop shortcut stays virtual, so an installed CodeShell keeps it.
 */
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import { installExternalCliFixture } from "./external-cli-fixture.mjs";
import {
  approveOnce,
  claudeTurn,
  computerUseLog,
  dismissTrust,
  muteStopNotice,
  pause,
  registerProject,
  selectModel,
  send,
  waitFor,
} from "./external-computer-use-acceptance-kit.mjs";

const execFile = promisify(execFileCallback);
const OPT_IN = "act-on-my-desktop";
const bundle = process.env.CODESHELL_E2E_REAL_COMPUTER_USE_BUNDLE;
if (process.env.CODESHELL_E2E_REAL_COMPUTER_USE !== OPT_IN || !bundle?.startsWith("/")) {
  console.error(
    `Refusing to run: this spec acts on the real desktop. Set CODESHELL_E2E_REAL_COMPUTER_USE=${OPT_IN} ` +
      "and CODESHELL_E2E_REAL_COMPUTER_USE_BUNDLE to an already-authorised CodeShell Computer Use.app.",
  );
  process.exit(2);
}
assert(process.platform === "darwin", "The real-driver acceptance needs macOS");
process.env[ACCEPTANCE_MOCK_KEYCHAIN_ENV] = "1";

const TARGET = { name: "Calculator", path: "/System/Applications/Calculator.app" };
const SERVER = "codeshell_computer";
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const helperPath = join(bundle, "Contents", "MacOS", "codeshell-computer-use");
const driverPath = join(bundle, "Contents", "Resources", "cua-driver");
const evidenceDir = process.env.CODESHELL_ACCEPTANCE_SCREENSHOT_DIR;
const isolated = await makeIsolatedElectronHome("codeshell-computer-use-real-");
const projectPath = join(isolated.home, "acceptance-project");
let app, win, cli, targetPid;

const run = async (command, args, options = {}) => {
  const { stdout, stderr } = await execFile(command, args, { encoding: "utf8", ...options });
  return stdout + stderr;
};
const pids = async (...pgrepArgs) =>
  (await run("/usr/bin/pgrep", pgrepArgs).catch(() => "")).split("\n").filter(Boolean).map(Number);

async function evidence(name, value) {
  if (!evidenceDir) return;
  await mkdir(evidenceDir, { recursive: true });
  if (name.endsWith(".png"))
    await win.screenshot({ path: join(evidenceDir, name), animations: "disabled" });
  else await writeFile(join(evidenceDir, name), JSON.stringify(value, null, 2));
}

/** Everything here is passive: no helper daemon, no permission request. */
async function preflight() {
  const requirement = await run("/usr/bin/codesign", ["-d", "-r-", bundle]);
  await run("/usr/bin/codesign", ["--verify", "--strict", bundle]);
  assert(
    requirement.includes("designated =>") && !requirement.includes("cdhash"),
    `The helper is ad-hoc signed; macOS cannot already trust it:\n${requirement}`,
  );
  const lock = JSON.parse(
    await readFile(join(appDir, "resources", "cua-driver.lock.json"), "utf8"),
  );
  const version = (await run(driverPath, ["--version"])).trim();
  assert(
    version === `cua-driver ${lock.version}`,
    `The bundle carries ${version}; this build is pinned to cua-driver ${lock.version}`,
  );
  // The helper's `status` reads AXIsProcessTrusted / CGPreflightScreenCaptureAccess.
  const status = JSON.parse(
    await run(helperPath, ["launch", "status"], {
      env: { HOME: isolated.home, TMPDIR: process.env.TMPDIR, PATH: "/usr/bin:/bin" },
      timeout: 15_000,
    }),
  );
  assert(
    status.version === 1 && status.requested === false && status.accessibility === true,
    `Accessibility is not granted to this helper (${JSON.stringify(status)}); not starting it`,
  );
  assert(
    (await pids("-x", TARGET.name)).length === 0,
    `${TARGET.name} is already running; this spec only acts on an instance it started`,
  );
  console.log(
    `acceptance: preflight ok — ${version}, ${requirement.split("\n").find((line) => line.includes("designated =>"))}`,
  );
  console.log(`acceptance: helper status (passive) ${JSON.stringify(status)}`);
}

async function startTarget() {
  // -g: never brought to the front; -n: an instance of our own.
  await run("/usr/bin/open", ["-g", "-n", "-a", TARGET.path]);
  const [pid, ...others] = await waitFor(
    async () => ((await pids("-x", TARGET.name)).length ? pids("-x", TARGET.name) : undefined),
    `${TARGET.name} to start`,
  );
  assert(others.length === 0, `More than one ${TARGET.name} appeared; not acting on any`);
  targetPid = pid;
}

async function stopTarget() {
  if (!targetPid) return;
  const command = (
    await run("/bin/ps", ["-p", String(targetPid), "-o", "comm="]).catch(() => "")
  ).trim();
  if (command.endsWith(`/${TARGET.name}`)) process.kill(targetPid, "SIGTERM");
}

const structured = (entry) => entry?.result?.structuredContent ?? {};
const refusal = (entry) => structured(entry).reason;
const buttons = (entry) =>
  (structured(entry).elements ?? []).filter((element) => element.role === "AXButton");
/** What the calculator shows: its static texts, as the driver's tree prints them. */
const display = (entry) =>
  (structured(entry).tree_markdown ?? "")
    .split("\n")
    .filter((line) => line.includes('AXStaticText = "'))
    .map((line) =>
      line.slice(line.indexOf('= "') + 3, line.lastIndexOf('"')).replace(/\u200e/g, ""),
    )
    .join(" | ");

try {
  await preflight();
  cli = await installExternalCliFixture(join(isolated.home, "external-cli"));
  await mkdir(projectPath, { recursive: true });
  await mkdir(isolated.codeShellHome, { recursive: true });
  await writeFile(
    join(isolated.codeShellHome, "settings.json"),
    JSON.stringify({ autoUpdates: false, featureFlags: { computer_use_cua: true } }),
  );
  // The driver's config lives under the isolated HOME; keep its telemetry off.
  await mkdir(join(isolated.home, ".cua-driver"), { recursive: true });
  await writeFile(
    join(isolated.home, ".cua-driver", "config.json"),
    JSON.stringify({ telemetry_enabled: false }),
  );
  await seedOfflinePluginBootstrap(isolated.codeShellHome);

  app = await launchCodeShellElectron({
    appDir,
    home: isolated.home,
    userDataDir: isolated.userDataDir,
    env: {
      PATH: cli.bin + ":" + process.env.PATH,
      CODE_SHELL_EXTERNAL_CLI_DIR: cli.bin,
      CODESHELL_E2E_COMPUTER_USE_BUNDLE: bundle,
      CODESHELL_E2E_STOP_SHORTCUT: "virtual",
    },
  });
  win = await findCodeShellWindow(app);
  await win.setViewportSize({ width: 1360, height: 860 });
  const errors = captureRendererErrors(win);
  await muteStopNotice(app);
  await dismissTrust(win);
  const appPid = await app.evaluate(() => process.pid);
  await waitFor(
    async () =>
      (await computerUseLog(isolated.codeShellHome)).some(
        (entry) => entry.msg === "cua_driver_running",
      ),
    "the real driver daemon to accept connections",
  );
  const chain = await run("/usr/bin/pgrep", ["-fl", `cs-cua-${appPid}-`]);
  assert(
    chain.includes(`${helperPath} launch serve`) && chain.includes(`${driverPath} serve`),
    `The app did not start the given helper and driver:\n${chain}`,
  );
  console.log("acceptance: the app started the real helper and its driver daemon");

  await registerProject(app, win, projectPath);
  await dismissTrust(win);
  await selectModel(win, "claude-code/sonnet");
  await startTarget();
  console.log(`acceptance: started ${TARGET.name} in the background (pid ${targetPid})`);

  // --- Default permission mode: the first real call asks, and runs once approved.
  await cli.script([
    { computer: [{ name: "list_windows", arguments: { pid: targetPid } }], text: "real: listed" },
  ]);
  await send(win, "which windows does the calculator have?");
  await win
    .getByText(/Claude Code (想操控你的电脑|wants to control your computer)/)
    .waitFor({ timeout: 20_000 });
  await evidence("real-01-approval-card.png");
  await approveOnce(win).first().click();
  const listed = await claudeTurn(win, cli, 1);
  await evidence("real-01-list-windows.json", listed.computer);
  assert(
    listed.mcpServers.includes(SERVER) && listed.computer[0].asked && listed.computer[0].allowed,
    "The real driver call was not offered, asked about and approved",
  );
  const windows = (structured(listed.computer[0]).windows ?? []).filter(
    (entry) => entry.pid === targetPid,
  );
  assert(
    windows.length >= 1,
    `No window of our ${TARGET.name}: ${JSON.stringify(listed.computer[0].result).slice(0, 1500)}`,
  );
  const windowId = windows[0].window_id;
  await win.getByText("real: listed").first().waitFor({ timeout: 15_000 });
  console.log(`acceptance: approved list_windows reached the real driver (window ${windowId})`);

  // --- Full access: read the tree, press one button by element, read it back.
  await win.getByRole("button", { name: /默认权限|Default/ }).click();
  await win.getByRole("option", { name: /完全访问权限|Full access/ }).click();
  const read = {
    name: "get_window_state",
    arguments: { pid: targetPid, window_id: windowId, include_screenshot: false },
  };
  const press = (label, call = 0) => ({
    name: "click",
    arguments: { pid: targetPid },
    tokenFrom: { call, role: "AXButton", label },
  });
  await cli.script([
    {
      computer: [read, press("1"), read, { name: "get_agent_cursor_state" }],
      text: "real: pressed 1",
    },
  ]);
  await send(win, "press 1");
  const pressed = await claudeTurn(win, cli, 2, { noCard: true });
  await evidence("real-02-press-1.json", pressed.computer);
  const [before, click, after, cursor] = pressed.computer;
  assert(
    click.unresolved === undefined && click.result && !click.result.isError,
    `The button was not pressed: ${JSON.stringify({
      unresolved: click.unresolved,
      result: click.result,
      buttons: buttons(before).map((element) => element.label),
    }).slice(0, 2500)}`,
  );
  assert(
    display(after) !== display(before) && display(after).endsWith("1"),
    `The press did not land: display ${display(before)} -> ${display(after)}`,
  );
  await win.getByText("real: pressed 1").first().waitFor({ timeout: 15_000 });
  await evidence("real-02-after-press.png");
  console.log(
    `acceptance: AX press on "1" landed in pid ${targetPid}: display ${display(before) || "(empty)"} -> ${display(after)}; ` +
      `driver agent cursor at ${JSON.stringify(structured(cursor).position)}`,
  );

  // --- Stop mid-turn: the next real input is refused, and the display proves it.
  const calls = (await cli.computerCalls()).length;
  await cli.script([
    { computer: [read, press("2")], holdMs: 30_000, afterSignal: [read, press("3"), read] },
  ]);
  await send(win, "press 2 and keep going until I stop you");
  await waitFor(
    async () => (await cli.computerCalls()).length >= calls + 2,
    "the held turn's press",
  );
  await win.getByRole("button", { name: /^(停止|Stop)$/ }).click();
  const stopped = await waitFor(async () => {
    const made = (await cli.computerCalls()).slice(calls);
    return made.filter((call) => call.phase === "after-signal").length === 3 ? made : undefined;
  }, "the stopped turn's last calls");
  await evidence("real-03-stop.json", stopped);
  const [, second, afterSecond, refused, afterRefused] = stopped;
  assert(
    second.result && !second.result.isError && display(afterSecond) === display(after) + "2",
    `The press before Stop did not land: ${display(after)} -> ${display(afterSecond)}`,
  );
  assert(
    refused.unresolved === undefined &&
      refusal(refused) === "session-cancelled" &&
      display(afterRefused) === display(afterSecond),
    `After Stop: ${refusal(refused) ?? "ran"}; display ${display(afterSecond)} -> ${display(afterRefused)}`,
  );
  await claudeTurn(win, cli, 3);
  await evidence("real-03-stopped.png");
  console.log(
    `acceptance: Stop refused the next press (session-cancelled); display stayed ${display(afterRefused)}`,
  );

  assert(errors.length === 0, `Renderer errors: ${errors.map((e) => e.message).join("; ")}`);
  console.log("CodeShell external computer use real-driver acceptance: passed");
} catch (error) {
  await evidence("real-failure.png").catch(() => undefined);
  throw error;
} finally {
  await stopTarget().catch(() => undefined);
  const appPid = await app?.evaluate(() => process.pid).catch(() => undefined);
  await app?.close().catch(() => undefined);
  if (appPid) {
    // The helper and daemon end with their owner; say so if they did not.
    for (let i = 0; i < 50 && (await pids("-f", `cs-cua-${appPid}-`)).length; i++) await pause(100);
    const left = await pids("-f", `cs-cua-${appPid}-`);
    if (left.length) {
      console.error(`The helper or driver outlived the app: ${left.join(", ")}`);
      process.exitCode = 1;
    }
  }
  for (let i = 0; i < 50 && targetPid && (await pids("-x", TARGET.name)).includes(targetPid); i++)
    await pause(100);
  if (targetPid && (await pids("-x", TARGET.name)).includes(targetPid)) {
    console.error(`${TARGET.name} (pid ${targetPid}) is still running`);
    process.exitCode = 1;
  }
  await isolated.cleanup();
}
