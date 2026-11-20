/*
 * Real Electron acceptance for Computer Use in external-runtime (Claude Code)
 * sessions: the `codeshell_computer` server a session is offered, the approval
 * card, the input gate, Stop / interrupt-and-send, the ⌘⇧Esc stop shortcut
 * (its handler, called through a seam: no key is synthesized or taken), and the
 * cases that get no computer-use server at all.
 *
 * Opt-in (not part of `test:e2e`). The app, its MCP proxy, input gate and
 * approval path are the real ones; the helper bundle behind them is a stand-in
 * (`computer-use-stand-in.mjs`) and `claude` is a scripted stand-in CLI. So no
 * call reaches the desktop and macOS is never asked for a privacy permission.
 * What this cannot show is the on-screen action itself (a click landing):
 * `e2e-external-computer-use-real-driver.mjs` does, behind its own opt-in.
 */
/* global window */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isolated = await makeIsolatedElectronHome("codeshell-computer-use-acceptance-");
const screenshotDir = process.env.CODESHELL_ACCEPTANCE_SCREENSHOT_DIR;
const projectPath = join(isolated.home, "acceptance-project");
const modelKey = "claude-code/sonnet";
const codexModelKey = "codex/gpt-5.6-sol";
const SERVER = "codeshell_computer";
let app, win, cli, standIn;

async function screenshot(name) {
  if (!screenshotDir) return;
  await mkdir(screenshotDir, { recursive: true });
  await win.screenshot({ path: join(screenshotDir, name), animations: "disabled" });
}

const { pause, waitFor } = kit;

async function settings(computerUse) {
  await writeFile(
    join(isolated.codeShellHome, "settings.json"),
    JSON.stringify({ autoUpdates: false, featureFlags: { computer_use_cua: computerUse } }),
  );
}

async function launch() {
  app = await launchCodeShellElectron({
    appDir,
    home: isolated.home,
    userDataDir: isolated.userDataDir,
    env: {
      PATH: cli.bin + ":" + process.env.PATH,
      CODE_SHELL_EXTERNAL_CLI_DIR: cli.bin,
      // The only helper this run may start. Unset, the app would use the built one.
      CODESHELL_E2E_COMPUTER_USE_BUNDLE: standIn.bundle,
      // ⌘⇧Esc is never taken system-wide: an installed CodeShell keeps its own.
      CODESHELL_E2E_STOP_SHORTCUT: "virtual",
    },
  });
  win = await findCodeShellWindow(app);
  await win.setViewportSize({ width: 1360, height: 860 });
  return captureRendererErrors(win);
}

/** Make "is the user at the keyboard" a fact of the test, not of the machine. */
const setUserIdleSeconds = (seconds) =>
  app.evaluate(({ powerMonitor }, value) => {
    powerMonitor.getSystemIdleTime = () => value;
  }, seconds);

const dismissTrust = () => kit.dismissTrust(win);
const registerProject = () => kit.registerProject(app, win, projectPath);
const selectModel = (wanted = modelKey) => kit.selectModel(win, wanted);
const send = (text) => kit.send(win, text);
const approveOnce = () => kit.approveOnce(win);
const turn = (count, options) => kit.claudeTurn(win, cli, count, options);

const refusal = (entry) => entry?.result?.structuredContent?.reason;
const driverNames = async () => (await standIn.driverCalls()).map((call) => call.driver);

try {
  cli = await installExternalCliFixture(join(isolated.home, "external-cli"));
  standIn = await installComputerUseStandIn(join(isolated.home, "computer-use"));
  await mkdir(projectPath, { recursive: true });
  await mkdir(isolated.codeShellHome, { recursive: true });
  await settings(true);
  await seedOfflinePluginBootstrap(isolated.codeShellHome);

  const errors = await launch();
  await setUserIdleSeconds(9999);
  await dismissTrust();
  await waitFor(
    async () => (await standIn.helperLaunches()).some((entry) => entry.helper === "launch serve"),
    "the stand-in helper to be started by the app",
  );
  console.log("acceptance: the app started the stand-in helper, not a real driver");

  await registerProject();
  await dismissTrust();
  await selectModel();

  // --- Default permission mode: offered, and a read-only call asks first.
  const card = win.getByText(/Claude Code (想操控你的电脑|wants to control your computer)/);
  await cli.script([{ computer: [{ name: "list_apps" }], text: "fixture: denied" }]);
  await send("which apps are open?");
  await card.waitFor({ timeout: 20_000 });
  await screenshot("01-default-mode-approval-card.png");
  assert(
    (await win.getByText(/native .* tool/).count()) === 0 &&
      (await win
        .getByRole("button", { name: /^(本会话一直允许|Always allow this session)$/ })
        .count()) === 0,
    "The computer-use card reads as a native tool or offers a standing approval",
  );
  await win
    .getByRole("button", { name: /^(拒绝|Deny)$/ })
    .first()
    .click();
  const denied = await turn(1);
  const offered = denied.computerTools ?? [];
  assert(
    denied.mcpServers.includes(SERVER) &&
      offered.includes("click") &&
      offered.includes("set_value"),
    `The session was not offered computer use: ${denied.mcpServers} / ${offered}`,
  );
  // The real proxy is in front: its withheld tools are gone, its policy notes are on.
  assert(
    !offered.includes("page") &&
      !offered.some((name) => name.startsWith("browser_")) &&
      denied.computerToolNotes === offered.length,
    `The tool list did not come through the gated proxy: ${offered}`,
  );
  const sessionId = denied.computerSession;
  assert(
    /^s-[a-z0-9-]+$/.test(sessionId ?? "") &&
      (await win.evaluate(
        (id) => JSON.stringify(Object.entries(window.localStorage)).includes(id),
        sessionId,
      )),
    `The proxy is not pinned to this window's session: ${sessionId}`,
  );
  assert(
    denied.computer[0].asked &&
      !denied.computer[0].allowed &&
      /"behavior\\":\\"deny/.test(denied.computer[0].answer) &&
      (await driverNames()).length === 0,
    "A denied computer-use call was not refused to the CLI, or reached the driver",
  );
  await win.getByText("fixture: denied").first().waitFor({ timeout: 15_000 });
  console.log(
    `acceptance: offered ${offered.length} gated tools, pinned to ${sessionId}; deny held`,
  );

  await cli.script([{ computer: [{ name: "list_apps" }], text: "fixture: approved" }]);
  await send("try again, I will approve");
  await card.waitFor({ timeout: 20_000 });
  await approveOnce().first().click();
  const approved = await turn(2);
  const reached = await standIn.driverCalls();
  assert(
    approved.computer[0].allowed &&
      /stand-in driver ran list_apps/.test(JSON.stringify(approved.computer[0].result)) &&
      reached.length === 1 &&
      reached[0].driver === "list_apps" &&
      reached[0].meta.length === 0,
    `An approved call did not reach the driver exactly once: ${JSON.stringify(reached)}`,
  );
  await win.getByText("fixture: approved").first().waitFor({ timeout: 15_000 });
  console.log(
    "acceptance: approve-once forwarded one call; the session lineage stayed in the proxy",
  );

  // --- Full access: no card. The input gate still decides what may act.
  await win.getByRole("button", { name: /默认权限|Default/ }).click();
  await win.getByRole("option", { name: /完全访问权限|Full access/ }).click();
  const background = { name: "click", arguments: { pid: 1, element_index: 2 } };
  const foreground = {
    name: "click",
    arguments: { pid: 1, element_index: 2, delivery_mode: "foreground" },
    delayMs: 800,
  };
  await setUserIdleSeconds(0);
  await cli.script([
    {
      computer: [
        { name: "list_apps" },
        background,
        foreground,
        { name: "launch_app", arguments: { bundle_id: "com.example.acceptance" } },
        { name: "page", arguments: {} },
      ],
      text: "fixture: user was active",
    },
  ]);
  await send("click it for me");
  const active = await turn(3, { noCard: true });
  assert(
    active.permissionMode === "bypassPermissions" && active.computer.every((call) => !call.asked),
    "Full access still asked for approval",
  );
  assert(
    active.computer.map((call) => refusal(call) ?? "ran").join(",") ===
      "ran,ran,user-active,user-active,tool-withheld",
    `The input gate decided ${active.computer.map((call) => refusal(call) ?? "ran")}`,
  );
  assert(
    (await driverNames()).join(",") === "list_apps,list_apps,click" &&
      (await standIn.driverCalls())[2].arguments.delivery_mode === undefined,
    `A refused call reached the driver: ${await driverNames()}`,
  );
  await screenshot("02-full-access-no-card.png");
  console.log(
    "acceptance: full access asked nothing; foreground input refused while the user is active",
  );

  // With the user away the same foreground call is let through (to the stand-in).
  await setUserIdleSeconds(9999);
  await cli.script([{ computer: [foreground], text: "fixture: user was away" }]);
  await send("now bring it forward");
  const away = await turn(4, { noCard: true });
  assert(
    refusal(away.computer[0]) === undefined &&
      (await standIn.driverCalls()).at(-1).arguments.delivery_mode === "foreground",
    "Foreground input was refused although the user was idle",
  );
  await win.getByText("fixture: user was away").first().waitFor({ timeout: 15_000 });

  // --- Stop mid-turn: the run's next input is refused as cancelled; reads still pass.
  const held = {
    computer: [background],
    holdMs: 30_000,
    afterSignal: [background, { name: "list_apps" }],
  };
  const afterSignal = async (calls) =>
    waitFor(async () => {
      const made = (await cli.computerCalls()).slice(calls);
      return made.filter((call) => call.phase === "after-signal").length === 2 ? made : undefined;
    }, "the interrupted turn's last calls");
  let calls = (await cli.computerCalls()).length;
  let reachedDriver = (await driverNames()).length;
  await cli.script([held]);
  await send("keep clicking until I stop you");
  await waitFor(
    async () => (await cli.computerCalls()).length > calls,
    "the held turn's first call",
  );
  await win.getByRole("button", { name: /^(停止|Stop)$/ }).click();
  const stopped = await afterSignal(calls);
  assert(
    stopped.map((call) => refusal(call) ?? "ran").join(",") === "ran,session-cancelled,ran" &&
      (await driverNames()).slice(reachedDriver).join(",") === "click,list_apps",
    `After Stop the gate decided ${stopped.map((call) => refusal(call) ?? "ran")}; driver saw ${(await driverNames()).slice(reachedDriver)}`,
  );
  await turn(5);
  await screenshot("03-stopped-mid-turn.png");
  console.log("acceptance: Stop refused this session's next input as session-cancelled");

  // The session's next run starts clean.
  await cli.script([{ computer: [background], text: "fixture: next run" }]);
  await send("carry on");
  const resumed = await turn(6, { noCard: true });
  assert(refusal(resumed.computer[0]) === undefined, "A Stop outlived the run it stopped");
  await win.getByText("fixture: next run").first().waitFor({ timeout: 15_000 });

  // --- Interrupt-and-send cancels the interrupted run's input the same way.
  calls = (await cli.computerCalls()).length;
  reachedDriver = (await driverNames()).length;
  await cli.script([held, { computer: [background], text: "fixture: redirected" }]);
  await send("keep clicking again");
  await waitFor(
    async () => (await cli.computerCalls()).length > calls,
    "the held turn's first call",
  );
  await win.locator("textarea:visible").last().fill("stop that, do this instead");
  await win.getByRole("button", { name: /^(引导|Guide)$/ }).click();
  const interrupted = await afterSignal(calls);
  assert(
    interrupted.map((call) => refusal(call) ?? "ran").join(",") === "ran,session-cancelled,ran",
    `After interrupt-and-send the gate decided ${interrupted.map((call) => refusal(call) ?? "ran")}`,
  );
  const redirected = await turn(8, { noCard: true });
  assert(
    redirected.prompt.includes("do this instead") && refusal(redirected.computer[0]) === undefined,
    "The message sent with the interrupt did not start a clean run",
  );
  await win.getByText("fixture: redirected").first().waitFor({ timeout: 15_000 });
  await screenshot("04-interrupt-and-send.png");
  console.log("acceptance: interrupt-and-send cancelled the old run; the new one could act");

  // --- ⌘⇧Esc. Desktop registers it while a computer-use proxy is connected. The
  // callback it registered is called through the acceptance seam: no key event
  // is synthesized and the system-wide key is never taken.
  const inputStatus = async () =>
    (await win.evaluate(() => window.codeshell.computerUse.status())).input;
  const logged = async (msg, source) =>
    (await kit.computerUseLog(isolated.codeShellHome)).filter(
      (entry) => entry.msg === msg && (source === undefined || entry.source === source),
    ).length;
  const slow = { ...background, delayMs: 4000 };
  await kit.muteStopNotice(app);
  await waitFor(
    async () => !(await kit.stopShortcutRegistered(app)),
    "the shortcut to be released with the last proxy",
  );
  calls = (await cli.computerCalls()).length;
  reachedDriver = (await driverNames()).length;
  await cli.script([
    { computer: [background, slow, { name: "list_apps" }], text: "fixture: after the shortcut" },
  ]);
  await send("keep clicking, I will press the shortcut");
  await waitFor(
    async () => (await cli.computerCalls()).length > calls,
    "the first call before the shortcut",
  );
  assert(
    await kit.stopShortcutRegistered(app),
    "⌘⇧Esc was not registered while a computer-use proxy was connected",
  );
  await kit.pressStopShortcut(app);
  const shortcut = await turn(9, { noCard: true });
  assert(
    shortcut.computer.map((call) => refusal(call) ?? "ran").join(",") === "ran,user-stop,ran" &&
      (await driverNames()).slice(reachedDriver).join(",") === "click,list_apps",
    `After ⌘⇧Esc the gate decided ${shortcut.computer.map((call) => refusal(call) ?? "ran")}; driver saw ${(await driverNames()).slice(reachedDriver)}`,
  );
  // Unlike Stop it does not end the run: the turn finished and replied.
  await win.getByText("fixture: after the shortcut").first().waitFor({ timeout: 15_000 });
  assert(
    !shortcut.signalled &&
      (await kit.stopNotices(app)) === 1 &&
      (await logged("computer_input_stopped", "shortcut")) === 1 &&
      (await inputStatus()).stopped === true,
    `⌘⇧Esc did not report the stop: ${JSON.stringify(await inputStatus())}`,
  );
  await screenshot("11-stop-shortcut.png");

  // The hold covers every later run until the user resumes.
  await cli.script([{ computer: [background], text: "fixture: still stopped" }]);
  await send("try once more");
  assert(
    refusal((await turn(10, { noCard: true })).computer[0]) === "user-stop",
    "A ⌘⇧Esc stop did not outlive the run it interrupted",
  );
  await win.getByText("fixture: still stopped").first().waitFor({ timeout: 15_000 });
  await win.evaluate(() => window.codeshell.computerUse.controlInput("resume"));
  await cli.script([{ computer: [background], text: "fixture: resumed" }]);
  await send("continue now");
  assert(
    refusal((await turn(11, { noCard: true })).computer[0]) === undefined,
    "Resume did not lift the ⌘⇧Esc stop",
  );
  await win.getByText("fixture: resumed").first().waitFor({ timeout: 15_000 });
  console.log(
    "acceptance: ⌘⇧Esc held every input (user-stop) without ending the run; resume lifted it",
  );

  // A refused registration is reported where the input state is shown, and the
  // on-screen stop still works.
  await waitFor(
    async () => !(await kit.stopShortcutRegistered(app)),
    "the shortcut to be released with the last proxy",
  );
  await app.evaluate(() => {
    process.env.CODESHELL_E2E_STOP_SHORTCUT = "unavailable";
  });
  assert((await inputStatus()).shortcutUnavailable === false, "An idle app reported no shortcut");
  calls = (await cli.computerCalls()).length;
  await cli.script([{ computer: [background, slow], text: "fixture: no shortcut" }]);
  await send("keep clicking without the shortcut");
  await waitFor(
    async () => (await cli.computerCalls()).length > calls,
    "the first call without the shortcut",
  );
  const missing = await inputStatus();
  assert(
    missing.shortcutUnavailable === true &&
      !missing.stopped &&
      !(await kit.stopShortcutRegistered(app)),
    `A refused ⌘⇧Esc registration was not reported: ${JSON.stringify(missing)}`,
  );
  await win.evaluate(() => window.codeshell.computerUse.controlInput("stop"));
  assert(
    refusal((await turn(12, { noCard: true })).computer[1]) === "user-stop",
    "The on-screen stop did not hold input while the shortcut was unavailable",
  );
  assert(
    (await logged("computer_input_shortcut_unavailable")) === 1,
    "A refused ⌘⇧Esc registration was not logged exactly once",
  );
  await win.getByText("fixture: no shortcut").first().waitFor({ timeout: 15_000 });
  await win.evaluate(() => window.codeshell.computerUse.controlInput("resume"));
  await app.evaluate(() => {
    process.env.CODESHELL_E2E_STOP_SHORTCUT = "virtual";
  });
  await waitFor(
    async () => (await inputStatus()).shortcutUnavailable === false,
    "the warning to clear once no proxy is connected",
  );
  console.log("acceptance: a refused ⌘⇧Esc registration was logged and reported; Stop still held");

  // --- Plan mode: no computer-use server at all.
  await win.getByRole("button", { name: /完全访问权限|Full access/ }).click();
  await win.getByRole("option", { name: /计划模式|Plan/ }).click();
  await cli.script([{ computer: [{ name: "list_apps" }], text: "fixture: planning" }]);
  await send("plan the next step");
  const planning = await turn(13, { noCard: true });
  assert(
    planning.permissionMode === "plan" &&
      !planning.mcpServers.includes(SERVER) &&
      planning.mcpServers.includes("codeshell_tools"),
    `Plan mode listed ${planning.mcpServers} (${planning.permissionMode})`,
  );
  await win.getByText("fixture: planning").first().waitFor({ timeout: 15_000 });
  await screenshot("05-plan-mode.png");
  console.log("acceptance: plan mode offered no computer-use server");

  await win.getByRole("button", { name: /计划模式|Plan/ }).click();
  await win.getByRole("option", { name: /默认权限|Default/ }).click();

  // === The same, for a Codex session (app-server protocol, MCP approval elicitation).
  const codexTurns = async () =>
    (await cli.codexEvents()).filter((entry) => entry.event === "scripted-turn");
  const codexSpawn = async () =>
    (await cli.codexEvents()).filter((entry) => entry.event === "spawn").at(-1);
  const codexTurn = async (count, { noCard = false } = {}) => {
    const deadline = Date.now() + 40_000;
    while ((await codexTurns()).length < count) {
      assert(Date.now() < deadline, `Timed out waiting for scripted Codex turn ${count}`);
      if (noCard)
        assert(
          !(await approveOnce().first().isVisible()),
          "An approval card was shown unexpectedly",
        );
      await pause(100);
    }
    return (await codexTurns())[count - 1];
  };
  await win
    .locator("aside")
    .getByRole("button", { name: /acceptance-project.*(新对话|new)/i })
    .click();
  await selectModel(codexModelKey);
  const codexCard = win.getByText(/Codex (想操控你的电脑|wants to control your computer)/);
  await cli.scriptCodex([{ computer: [{ name: "list_apps" }], text: "codex fixture: denied" }]);
  reachedDriver = (await driverNames()).length;
  await send("codex, which apps are open?");
  await codexCard.waitFor({ timeout: 30_000 });
  await screenshot("08-codex-default-mode-approval-card.png");
  // The elicitation names no tool; the card still says which one.
  assert(
    (await win.getByText("Computer use: list_apps").count()) > 0 &&
      (await win
        .getByRole("button", { name: /^(本会话一直允许|Always allow this session)$/ })
        .count()) === 0,
    "The Codex computer-use card does not name the tool, or offers a standing approval",
  );
  await win
    .getByRole("button", { name: /^(拒绝|Deny)$/ })
    .first()
    .click();
  const codexDenied = await codexTurn(1);
  const declared = await codexSpawn();
  assert(
    declared.servers.includes(SERVER) &&
      declared.secretNames.length > 0 &&
      declared.secretsInEnv &&
      !declared.secretsInArgv,
    `Codex was not given the server with its token out of argv: ${JSON.stringify(declared)}`,
  );
  const codexSessionId = declared.computerSession;
  assert(
    /^s-[a-z0-9-]+$/.test(codexSessionId ?? "") &&
      codexSessionId !== sessionId &&
      (await win.evaluate(
        (id) => JSON.stringify(Object.entries(window.localStorage)).includes(id),
        codexSessionId,
      )),
    `The Codex proxy is not pinned to its own session: ${codexSessionId}`,
  );
  assert(
    codexDenied.approvalPolicy === "on-request" &&
      codexDenied.computer[0].asked &&
      codexDenied.computer[0].answer === "decline" &&
      !codexDenied.computerTools.includes("page") &&
      (await driverNames()).length === reachedDriver,
    `A denied Codex call was not declined, or reached the driver: ${JSON.stringify(codexDenied.computer)}`,
  );
  console.log(`acceptance: Codex offered the gated server, pinned to ${codexSessionId}; deny held`);

  await cli.scriptCodex([{ computer: [{ name: "list_apps" }], text: "codex fixture: approved" }]);
  await send("try again, I will approve");
  await codexCard.waitFor({ timeout: 20_000 });
  await approveOnce().first().click();
  const codexApproved = await codexTurn(2);
  assert(
    codexApproved.computer[0].answer === "accept" &&
      (await driverNames()).slice(reachedDriver).join(",") === "list_apps",
    "An approved Codex call did not reach the driver exactly once",
  );
  await win.getByText("codex fixture: approved").first().waitFor({ timeout: 15_000 });

  await win.getByRole("button", { name: /默认权限|Default/ }).click();
  await win.getByRole("option", { name: /完全访问权限|Full access/ }).click();
  await setUserIdleSeconds(0);
  await cli.scriptCodex([
    { computer: [{ name: "list_apps" }, background, foreground], text: "codex fixture: active" },
  ]);
  await send("click it for me");
  const codexActive = await codexTurn(3, { noCard: true });
  assert(
    codexActive.approvalPolicy === "never" &&
      codexActive.computer.map((call) => refusal(call) ?? "ran").join(",") ===
        "ran,ran,user-active",
    `Codex full access: ${codexActive.approvalPolicy}, ${codexActive.computer.map((call) => refusal(call) ?? "ran")}`,
  );
  await setUserIdleSeconds(9999);
  await win.getByText("codex fixture: active").first().waitFor({ timeout: 15_000 });
  await screenshot("09-codex-full-access-no-card.png");
  console.log("acceptance: Codex full access asked nothing; the input gate still refused");

  calls = (await cli.computerCalls()).length;
  await cli.scriptCodex([held]);
  await send("keep clicking until I stop you");
  await waitFor(async () => (await cli.computerCalls()).length > calls, "the held Codex call");
  await win.getByRole("button", { name: /^(停止|Stop)$/ }).click();
  const codexStopped = await afterSignal(calls);
  assert(
    codexStopped.map((call) => refusal(call) ?? "ran").join(",") === "ran,session-cancelled,ran",
    `After Stop the gate decided ${codexStopped.map((call) => refusal(call) ?? "ran")} for Codex`,
  );
  await codexTurn(4);
  await cli.scriptCodex([{ computer: [background], text: "codex fixture: next run" }]);
  await send("carry on");
  assert(
    refusal((await codexTurn(5, { noCard: true })).computer[0]) === undefined,
    "A Stop outlived the Codex run it stopped",
  );
  await win.getByText("codex fixture: next run").first().waitFor({ timeout: 15_000 });

  calls = (await cli.computerCalls()).length;
  await cli.scriptCodex([held, { computer: [background], text: "codex fixture: redirected" }]);
  await send("keep clicking again");
  await waitFor(async () => (await cli.computerCalls()).length > calls, "the held Codex call");
  await win.locator("textarea:visible").last().fill("stop that, do this instead");
  await win.getByRole("button", { name: /^(引导|Guide)$/ }).click();
  const codexInterrupted = await afterSignal(calls);
  const codexRedirected = await codexTurn(7, { noCard: true });
  assert(
    codexInterrupted.map((call) => refusal(call) ?? "ran").join(",") ===
      "ran,session-cancelled,ran" &&
      codexRedirected.prompt.includes("do this instead") &&
      refusal(codexRedirected.computer[0]) === undefined,
    `Codex interrupt-and-send: ${codexInterrupted.map((call) => refusal(call) ?? "ran")}`,
  );
  await win.getByText("codex fixture: redirected").first().waitFor({ timeout: 15_000 });
  await screenshot("10-codex-stop-and-interrupt.png");
  console.log("acceptance: Codex Stop and interrupt-and-send cancelled; next runs could act");

  await win.getByRole("button", { name: /完全访问权限|Full access/ }).click();
  await win.getByRole("option", { name: /计划模式|Plan/ }).click();
  await cli.scriptCodex([{ computer: [{ name: "list_apps" }], text: "codex fixture: planning" }]);
  await send("plan the next step");
  const codexPlanning = await codexTurn(8, { noCard: true });
  assert(
    codexPlanning.sandbox === "read-only" &&
      !(await codexSpawn()).servers.includes(SERVER) &&
      (await codexSpawn()).servers.includes("codeshell_tools"),
    `Codex plan mode declared ${(await codexSpawn()).servers} (${codexPlanning.sandbox})`,
  );
  await win.getByText("codex fixture: planning").first().waitFor({ timeout: 15_000 });
  await win.getByRole("button", { name: /计划模式|Plan/ }).click();
  await win.getByRole("option", { name: /默认权限|Default/ }).click();
  console.log("acceptance: Codex plan mode declared no computer-use server");

  // --- A Mimi-hosted external session keeps the reviewed bridge as its only channel.
  await win.locator("aside").getByRole("button", { name: /Mimi/ }).first().click();
  await win.getByRole("button", { name: /选择模型|Select model/ }).click();
  await win.locator(`[data-model-key="${modelKey}"]`).first().click();
  await cli.script([{ computer: [{ name: "list_apps" }], text: "fixture: Mimi reply" }]);
  await send("what is on my screen?");
  const mimi = await turn(14, { noCard: true });
  assert(
    mimi.prompt.includes("pet-world") &&
      mimi.mcpServers.join(",") === "codeshell_tools" &&
      mimi.computerSession === null,
    `A Mimi-hosted session listed ${mimi.mcpServers}`,
  );
  // Mimi answers through her own reply tool, so the stand-in's text is not shown.
  await pause(1000);
  await screenshot("06-mimi-hosted.png");
  console.log("acceptance: Mimi-hosted session offered no computer-use server");

  // --- Setting off: the helper is never started and nothing is offered.
  const driverTotal = (await driverNames()).length;
  await app.close();
  await settings(false);
  errors.push(...(await launch()));
  await dismissTrust();
  await win.locator("aside").getByText("codex, which apps are open?").first().click();
  await selectModel(codexModelKey);
  await cli.scriptCodex([{ computer: [{ name: "list_apps" }], text: "codex fixture: off" }]);
  await send("which apps are open now?");
  const codexOff = await codexTurn(9, { noCard: true });
  assert(
    codexOff.approvalPolicy === "on-request" &&
      (await codexSpawn()).servers.join(",") === "codeshell_tools",
    `With the setting off Codex was given ${(await codexSpawn()).servers}`,
  );
  await win.getByText("codex fixture: off").first().waitFor({ timeout: 15_000 });
  await win.locator("aside").getByText("which apps are open?").first().click();
  await selectModel();
  await cli.script([{ computer: [{ name: "list_apps" }], text: "fixture: setting off" }]);
  await send("which apps are open now?");
  const off = await turn(15, { noCard: true });
  assert(
    off.permissionMode === "default" && off.mcpServers.join(",") === "codeshell_tools",
    `With the setting off the session listed ${off.mcpServers} (${off.permissionMode})`,
  );
  await win.getByText("fixture: setting off").first().waitFor({ timeout: 15_000 });
  assert(
    (await standIn.helperLaunches()).filter((entry) => entry.helper === "launch serve").length ===
      1 && (await driverNames()).length === driverTotal,
    "With the setting off the app still started the helper or reached the driver",
  );
  await screenshot("07-setting-off.png");
  console.log("acceptance: setting off started no helper and offered no computer-use server");

  assert(errors.length === 0, `Renderer errors: ${errors.map((e) => e.message).join("; ")}`);
  console.log("CodeShell external computer use acceptance: passed");
} catch (error) {
  await screenshot("failure.png").catch(() => undefined);
  if (cli) console.error(JSON.stringify(await cli.invocations().catch(() => [])).slice(0, 6000));
  throw error;
} finally {
  await app?.close().catch(() => undefined);
  await isolated.cleanup();
}
