/*
 * Real-driver acceptance for Computer Use in external-runtime sessions (a Claude
 * Code session, then a Codex session): the isolated app drives a REAL
 * "CodeShell Computer Use.app" and its cua-driver against one Calculator
 * instance this script starts and quits, and writes with `set_value` into a new
 * untitled document of a TextEdit instance it starts (skipped when TextEdit is
 * already running), then discards that document through its own window.
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
 * - Only element-addressed accessibility actions are sent, always to a pid
 *   started here. No pixel click, no typing, no hotkey, no
 *   foreground delivery, no launch through the driver, and no screenshot
 *   (`include_screenshot:false`: a capture can raise macOS's own periodic
 *   screen-recording confirmation).
 * - A click's or set_value's target is resolved from the tree read in the same
 *   turn and is sent only when exactly one element matches.
 * - The user-activity clock is the machine's real one; nothing fakes idleness.
 * - The ⌘⇧Esc stop shortcut stays virtual, so an installed CodeShell keeps it.
 */
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
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
// A new untitled document only: no open panel, and no window restored from or
// saved into the user's TextEdit state.
const EDITOR = { name: "TextEdit", path: "/System/Applications/TextEdit.app" };
const EDITOR_ARGS = [
  "-NSShowAppCentricOpenPanelInsteadOfUntitledFile",
  "NO",
  "-ApplePersistenceIgnoreState",
  "YES",
];
const CODEX_MODEL = "codex/gpt-5.6-sol";
let app, win, cli, targetPid, editorPid, editorSkipped, editorStateBefore;

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
  // TextEdit may hold the user's documents: if it runs, set_value is skipped.
  if ((await pids("-x", EDITOR.name)).length)
    editorSkipped = `${EDITOR.name} is already running for the user`;
  editorStateBefore = await editorState();
  console.log(
    `acceptance: preflight ok — ${version}, ${requirement.split("\n").find((line) => line.includes("designated =>"))}`,
  );
  console.log(`acceptance: helper status (passive) ${JSON.stringify(status)}`);
}

/** Names in TextEdit's autosave and saved-state folders (read only). */
async function editorState() {
  const library = join(homedir(), "Library", "Containers", "com.apple.TextEdit", "Data", "Library");
  const names = [];
  for (const folder of ["Autosave Information", "Saved Application State"])
    names.push(
      ...(await readdir(join(library, folder)).catch(() => [])).map((n) => `${folder}/${n}`),
    );
  return JSON.stringify(names.sort());
}

/** Start an instance of our own, in the background (-g: never fronted; -n: new). */
async function startApp(target, args = []) {
  await run("/usr/bin/open", [
    "-g",
    "-n",
    "-a",
    target.path,
    ...(args.length ? ["--args", ...args] : []),
  ]);
  const [pid, ...others] = await waitFor(
    async () => ((await pids("-x", target.name)).length ? pids("-x", target.name) : undefined),
    `${target.name} to start`,
  );
  assert(others.length === 0, `More than one ${target.name} appeared; not acting on any`);
  return pid;
}

async function stopApp(target, pid) {
  if (!pid) return;
  const command = (await run("/bin/ps", ["-p", String(pid), "-o", "comm="]).catch(() => "")).trim();
  if (command.endsWith(`/${target.name}`)) process.kill(pid, "SIGTERM");
}

async function confirmGone(target, pid) {
  for (let i = 0; i < 50 && pid && (await pids("-x", target.name)).includes(pid); i++)
    await pause(100);
  if (pid && (await pids("-x", target.name)).includes(pid)) {
    console.error(`${target.name} (pid ${pid}) is still running`);
    process.exitCode = 1;
  }
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

async function permissionMode(option) {
  await win
    .getByRole("button", { name: /默认权限|完全访问权限|Default|Full access/ })
    .first()
    .click();
  await win.getByRole("option", { name: option }).click();
}

const codexTurn = async (count) =>
  waitFor(
    async () => {
      const turns = (await cli.codexEvents()).filter((entry) => entry.event === "scripted-turn");
      return turns.length >= count ? turns[count - 1] : undefined;
    },
    `scripted Codex turn ${count}`,
    40_000,
  );

/**
 * Answer one Codex approval card per call, in order. Each card must name its
 * tool (the elicitation itself carries none); each answer is followed by that
 * call finishing before the next card is looked at.
 */
async function answerCards(tools, answers) {
  const start = (await cli.computerCalls()).length;
  for (const [index, tool] of tools.entries()) {
    const answer = Array.isArray(answers) ? answers[index] : answers;
    await approveOnce(win).first().waitFor({ timeout: 30_000 });
    assert(
      await win.getByText(`Computer use: ${tool}`).last().isVisible(),
      `The approval card does not name ${tool}`,
    );
    const button =
      answer === "deny"
        ? win.getByRole("button", { name: /^(拒绝|Deny)$/ }).first()
        : approveOnce(win).first();
    await button.click();
    await waitFor(
      async () => (await cli.computerCalls()).length > start + index,
      `the ${tool} call to finish after "${answer}"`,
      40_000,
    );
  }
}

/**
 * A new untitled TextEdit document of our own: set its text through the real
 * driver's `set_value` (approved), read it back from the accessibility tree,
 * then discard the document by ending that TextEdit pid.
 */
async function setValueInOwnEditor() {
  if ((await pids("-x", EDITOR.name)).length)
    return console.log(`acceptance: set_value skipped — ${EDITOR.name} started meanwhile`);
  editorPid = await startApp(EDITOR, EDITOR_ARGS);
  console.log(`acceptance: started ${EDITOR.name} in the background (pid ${editorPid})`);
  await permissionMode(/默认权限|Default/);
  const list = { name: "list_windows", arguments: { pid: editorPid } };
  await cli.scriptCodex([{ computer: [{ ...list, delayMs: 2000 }], text: "real codex: editor" }]);
  await send(win, "codex, which windows does the editor have?");
  await answerCards(["list_windows"], "approve");
  const listed = await codexTurn(4);
  const windows = (structured(listed.computer[0]).windows ?? []).filter(
    (entry) => entry.pid === editorPid,
  );
  assert(
    windows.length === 1,
    `Expected one untitled ${EDITOR.name} window: ${JSON.stringify(windows).slice(0, 1500)}`,
  );
  const editorWindow = windows[0].window_id;
  console.log(`acceptance: ${EDITOR.name} window ${editorWindow} "${windows[0].title ?? ""}"`);

  const readEditor = {
    name: "get_window_state",
    arguments: { pid: editorPid, window_id: editorWindow, include_screenshot: false },
  };
  const VALUE = "CodeShell set_value 验收 ✓";
  const has = (entry) => JSON.stringify(structured(entry)).includes(VALUE);
  await cli.scriptCodex([
    {
      computer: [
        readEditor,
        {
          name: "set_value",
          arguments: { pid: editorPid, value: VALUE },
          tokenFrom: { call: 0, role: "AXTextArea" },
        },
        readEditor,
      ],
      text: "real codex: value set",
    },
  ]);
  await send(win, "codex, write the line into the document");
  await answerCards(["get_window_state", "set_value", "get_window_state"], "approve");
  const written = await codexTurn(5);
  await evidence("real-07-set-value.json", written);
  const [beforeValue, setValue, afterValue] = written.computer;
  assert(
    setValue.unresolved === undefined &&
      setValue.answer === "accept" &&
      setValue.result &&
      !setValue.result.isError &&
      !has(beforeValue) &&
      has(afterValue),
    `set_value did not land: ${JSON.stringify({
      setValue,
      text: (structured(beforeValue).elements ?? []).filter((e) => e.role === "AXTextArea"),
    }).slice(0, 2500)}`,
  );
  await win.getByText("real codex: value set").first().waitFor({ timeout: 15_000 });
  console.log(
    `acceptance: approved set_value landed and read back: ${JSON.stringify(setValue.result.structuredContent ?? setValue.result.content?.[0]?.text ?? "").slice(0, 300)}`,
  );

  // This driver exposes the window's title-bar buttons without a title or
  // subrole, so no element can be told to be "close" for certain. The document
  // is discarded by ending our own TextEdit pid instead, and TextEdit's
  // autosave / saved-state folders are checked to have gained nothing.
  await stopApp(EDITOR, editorPid);
  await confirmGone(EDITOR, editorPid);
  const leftovers = await editorState();
  assert(
    leftovers === editorStateBefore,
    `TextEdit kept something of the discarded document: ${editorStateBefore} -> ${leftovers}`,
  );
  console.log(
    `acceptance: our ${EDITOR.name} (pid ${editorPid}) ended; no autosave or saved state left`,
  );
}

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
  targetPid = await startApp(TARGET);
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
      read: {
        ...before.result,
        structuredContent: undefined,
        keys: Object.keys(structured(before)),
        tree: (structured(before).tree_markdown ?? "").slice(0, 600),
      },
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
  let calls = (await cli.computerCalls()).length;
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

  // === A Codex session on the same real driver (app-server protocol: an
  // `mcpToolCall` item, then an approval elicitation naming no tool).
  await win
    .locator("aside")
    .getByRole("button", { name: /acceptance-project.*(新对话|new)/i })
    .click();
  await selectModel(win, CODEX_MODEL);
  await permissionMode(/默认权限|Default/);
  const codexCard = win.getByText(/Codex (想操控你的电脑|wants to control your computer)/);

  // Default permission: every call asks, the card names the real tool.
  await cli.scriptCodex([{ computer: [read, press("4"), read], text: "real codex: pressed 4" }]);
  await send(win, "codex, press 4");
  await codexCard.first().waitFor({ timeout: 30_000 });
  await answerCards(["get_window_state", "click", "get_window_state"], "approve");
  const codexPressed = await codexTurn(1);
  await evidence("real-04-codex-press-4.json", codexPressed);
  const [codexBefore, codexClick, codexAfter] = codexPressed.computer;
  assert(
    codexPressed.computerTools.includes("click") &&
      !codexPressed.computerTools.includes("page") &&
      codexClick.asked &&
      codexClick.answer === "accept" &&
      codexClick.result &&
      !codexClick.result.isError &&
      display(codexAfter) === display(codexBefore) + "4",
    `The approved Codex press did not land: ${display(codexBefore)} -> ${display(codexAfter)}; ${JSON.stringify(codexClick).slice(0, 1500)}`,
  );
  await win.getByText("real codex: pressed 4").first().waitFor({ timeout: 15_000 });
  console.log(
    `acceptance: Codex card named the tool; approved AX press landed: ${display(codexBefore)} -> ${display(codexAfter)}`,
  );

  // Deny: the decline reaches Codex and the driver is never called.
  await cli.scriptCodex([{ computer: [read, press("5"), read], text: "real codex: denied" }]);
  await send(win, "codex, press 5");
  await codexCard.first().waitFor({ timeout: 30_000 });
  await answerCards(
    ["get_window_state", "click", "get_window_state"],
    ["approve", "deny", "approve"],
  );
  const codexDenied = await codexTurn(2);
  await evidence("real-05-codex-deny.json", codexDenied);
  const [deniedBefore, deniedClick, deniedAfter] = codexDenied.computer;
  assert(
    deniedClick.asked &&
      deniedClick.answer === "decline" &&
      deniedClick.result === null &&
      display(deniedAfter) === display(deniedBefore) &&
      display(deniedBefore) === display(codexAfter),
    `A denied Codex press changed something: ${display(deniedBefore)} -> ${display(deniedAfter)}; ${JSON.stringify(deniedClick).slice(0, 800)}`,
  );
  await win.getByText("real codex: denied").first().waitFor({ timeout: 15_000 });
  console.log(`acceptance: Codex deny declined; the display stayed ${display(deniedAfter)}`);

  // Stop mid-turn (full access, so nothing asks): the next press is refused.
  await permissionMode(/完全访问权限|Full access/);
  calls = (await cli.computerCalls()).length;
  await cli.scriptCodex([
    { computer: [read, press("6")], holdMs: 30_000, afterSignal: [read, press("7"), read] },
  ]);
  await send(win, "codex, press 6 and keep going until I stop you");
  await waitFor(async () => (await cli.computerCalls()).length >= calls + 2, "Codex's held press");
  await win.getByRole("button", { name: /^(停止|Stop)$/ }).click();
  const codexStopped = await waitFor(async () => {
    const made = (await cli.computerCalls()).slice(calls);
    return made.filter((call) => call.phase === "after-signal").length === 3 ? made : undefined;
  }, "the stopped Codex turn's last calls");
  await evidence("real-06-codex-stop.json", codexStopped);
  const [, sixth, afterSixth, seventh, afterSeventh] = codexStopped;
  assert(
    sixth.result && !sixth.result.isError && display(afterSixth) === display(deniedAfter) + "6",
    `Codex's press before Stop did not land: ${display(deniedAfter)} -> ${display(afterSixth)}`,
  );
  assert(
    seventh.unresolved === undefined &&
      refusal(seventh) === "session-cancelled" &&
      display(afterSeventh) === display(afterSixth),
    `After Codex Stop: ${refusal(seventh) ?? "ran"}; display ${display(afterSixth)} -> ${display(afterSeventh)}`,
  );
  await codexTurn(3);
  console.log(
    `acceptance: Codex Stop refused the next press (session-cancelled); display stayed ${display(afterSeventh)}`,
  );

  // === set_value into a native text view of a TextEdit instance started here.
  if (editorSkipped) console.log(`acceptance: set_value skipped — ${editorSkipped}`);
  else await setValueInOwnEditor();

  assert(errors.length === 0, `Renderer errors: ${errors.map((e) => e.message).join("; ")}`);
  console.log("CodeShell external computer use real-driver acceptance: passed");
} catch (error) {
  await evidence("real-failure.png").catch(() => undefined);
  throw error;
} finally {
  await stopApp(TARGET, targetPid).catch(() => undefined);
  await stopApp(EDITOR, editorPid).catch(() => undefined);
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
  await confirmGone(TARGET, targetPid);
  await confirmGone(EDITOR, editorPid);
  await isolated.cleanup();
}
