/*
 * Real Electron acceptance for external-runtime (Claude Code) sessions: the
 * project browser partition, panel access prompt (unanswered, denied, granted),
 * Goal question banner, Goal pause truthfulness across a restart, and orphaned
 * partition cleanup. The unanswered request waits out its real 60 s timeout.
 *
 * Opt-in (not part of `test:e2e`). Never needs OS key storage, so it always
 * runs in the harness's mock-keychain acceptance mode; `claude` and `codex`
 * are scripted stand-ins placed first on PATH. Screenshots are written when
 * CODESHELL_ACCEPTANCE_SCREENSHOT_DIR is set.
 */
/* global document, window */
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACCEPTANCE_MOCK_KEYCHAIN_ENV,
  assert,
  captureRendererErrors,
  expandSidebar,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
  seedOfflinePluginBootstrap,
  waitForAsyncFunction,
} from "./electron-harness.mjs";
import { installExternalCliFixture } from "./external-cli-fixture.mjs";

process.env[ACCEPTANCE_MOCK_KEYCHAIN_ENV] = "1";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isolated = await makeIsolatedElectronHome("codeshell-external-acceptance-");
const screenshotDir = process.env.CODESHELL_ACCEPTANCE_SCREENSHOT_DIR;
const projectPath = join(isolated.home, "acceptance-project");
const partitions = join(isolated.userDataDir, "Partitions");
const orphan = "browser%3Ap%3Aexternal-runtime%3Aacceptance-orphan";
const kept = ["browser%3Ap%3Aacceptance-kept-project", "acceptance-unrelated"];
const modelKey = "claude-code/sonnet";
let app, win, cli, page;

async function screenshot(name) {
  if (!screenshotDir) return;
  await mkdir(screenshotDir, { recursive: true });
  await win.screenshot({ path: join(screenshotDir, name), animations: "disabled" });
}

async function launch() {
  app = await launchCodeShellElectron({
    appDir,
    home: isolated.home,
    userDataDir: isolated.userDataDir,
    env: { PATH: cli.bin + ":" + process.env.PATH, CODE_SHELL_EXTERNAL_CLI_DIR: cli.bin },
  });
  win = await findCodeShellWindow(app);
  await win.setViewportSize({ width: 1360, height: 860 });
  return captureRendererErrors(win);
}

async function dismissTrust() {
  const trust = win.getByRole("button", { name: /信任并继续|Trust and continue/i });
  if (
    await trust
      .waitFor({ timeout: 5000 })
      .then(() => true)
      .catch(() => false)
  )
    await trust.click();
}

async function registerProject() {
  await app.evaluate(({ dialog }, path) => {
    const original = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => {
      dialog.showOpenDialog = original;
      return { canceled: false, filePaths: [path] };
    };
  }, projectPath);
  await expandSidebar(win);
  await win
    .locator("aside")
    .getByRole("button", { name: /^(新项目|New project)$/ })
    .first()
    .click();
  const chooser = win.getByRole("dialog", { name: /^(新项目|New project)$/ });
  await chooser.getByRole("button", { name: /^(此计算机|This computer)$/ }).click();
  await waitForAsyncFunction(
    win,
    async (path) =>
      (await window.codeshell.projectRegistry.list()).some((entry) =>
        entry.roots.some((root) => root.path === path),
      ),
    projectPath,
  );
  return win.evaluate(
    async (path) =>
      (await window.codeshell.projectRegistry.list()).find((entry) =>
        entry.roots.some((root) => root.path === path),
      ),
    projectPath,
  );
}

async function selectModel() {
  const pill = win.locator("button[data-active-model]");
  await pill.waitFor({ state: "visible", timeout: 20_000 });
  if ((await pill.getAttribute("data-active-model")) === modelKey) return;
  await pill.click();
  await win.locator(`[data-model-key="${modelKey}"]`).click();
  await win.waitForFunction(
    (key) =>
      document.querySelector("button[data-active-model]")?.getAttribute("data-active-model") ===
      key,
    modelKey,
  );
}

async function send(text) {
  const composer = win.locator("textarea:visible").last();
  await composer.fill(text);
  await composer.press("Enter");
}

/** Wait for the scripted CLI's `count`th turn, approving each Host tool call once. */
async function waitForTurns(count, { timeout = 40_000, until, approve = true } = {}) {
  const once = win.getByRole("button", { name: /^(仅本次批准|Approve once)$/ });
  const deadline = Date.now() + timeout;
  while ((await cli.invocations()).length < count) {
    assert(Date.now() < deadline, `Timed out waiting for scripted turn ${count}`);
    if (await until?.()) return undefined;
    if (approve && (await once.first().isVisible())) await once.first().click();
    await new Promise((done) => setTimeout(done, 100));
  }
  return (await cli.invocations())[count - 1];
}

try {
  cli = await installExternalCliFixture(join(isolated.home, "external-cli"));
  await mkdir(projectPath, { recursive: true });
  await mkdir(isolated.codeShellHome, { recursive: true });
  await writeFile(
    join(isolated.codeShellHome, "settings.json"),
    JSON.stringify({ autoUpdates: false, featureFlags: { computer_use_cua: false } }),
  );
  await seedOfflinePluginBootstrap(isolated.codeShellHome);
  for (const name of [orphan, ...kept]) {
    await mkdir(join(partitions, name), { recursive: true });
    await writeFile(join(partitions, name, "marker"), name);
  }
  page = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Acceptance page</title><h1>Acceptance page</h1>");
  });
  page.listen(0, "127.0.0.1");
  await once(page, "listening");

  const errors = await launch();
  await dismissTrust();

  // Orphaned partition cleanup runs once at startup, before any window opens.
  const deadline = Date.now() + 10_000;
  while ((await readdir(partitions)).includes(orphan) && Date.now() < deadline)
    await new Promise((done) => setTimeout(done, 100));
  const remaining = await readdir(partitions);
  assert(!remaining.includes(orphan), "The orphaned external-runtime partition was not removed");
  assert(
    kept.every((name) => remaining.includes(name)),
    `Startup cleanup removed an unrelated partition: ${remaining.join(", ")}`,
  );
  console.log("acceptance: orphaned external-runtime partition removed; others kept");

  const project = await registerProject();
  await dismissTrust();
  await screenshot("01-project-registered.png");
  await selectModel();
  await cli.script([{ text: "fixture: first reply" }]);
  await send("hello fixture");
  await waitForTurns(1);
  await win.getByText("fixture: first reply").first().waitFor({ timeout: 15_000 });
  await screenshot("02-first-external-turn.png");

  // --- Browser: the session's panel tab lives in the project's partition.
  const pageUrl = `http://127.0.0.1:${page.address().port}/`;
  const toggle = win.locator('[data-panel-action="toggle"]');
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  await win.locator('[data-panel-action="new-tab"]:visible').click();
  await win.locator('[data-panel-menu-kind="browser"]').click();
  const slot = win.locator('[data-panel-id="browser"][data-panel-active="true"]');
  const address = slot.locator('input[placeholder*="URL"]');
  await address.fill(pageUrl);
  await address.press("Enter");
  await win.waitForFunction(
    (url) =>
      document
        .querySelector('[data-panel-id="browser"][data-panel-active="true"] webview')
        ?.getAttribute("src")
        ?.startsWith(url) === true,
    pageUrl,
  );
  const partition = await slot.locator("webview").getAttribute("partition");
  assert(
    partition === `persist:browser:p:${project.id}`,
    `External session tab uses partition ${partition}, not the project's`,
  );
  const storage = await app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((contents) => contents.getType() === "webview")
      .map((contents) => contents.session.storagePath),
  );
  assert(
    storage.length > 0 &&
      storage.every((path) => path?.endsWith(encodeURIComponent(`browser:p:${project.id}`))),
    `Unexpected panel storage: ${storage.join(", ")}`,
  );
  console.log(`acceptance: external session panel tab uses ${partition}`);

  const prompt = win.getByRole("status", { name: /请求操作此标签页|asks to use this tab/ });
  const panelTools = [
    { name: "browser_act", arguments: { action: "request_panel_access" } },
    { name: "browser_act", arguments: { action: "list_tabs" } },
  ];
  // Nobody answers: the request times out by itself (60 s), the bar goes away,
  // and a second request in the same turn is refused without prompting again.
  const requestPanel = panelTools[0];
  await cli.script([
    {
      tools: [requestPanel, requestPanel, panelTools[1]],
      text: "fixture: panel request unanswered",
    },
  ]);
  await send("use the page in my browser panel, I will not answer");
  // Default permission mode: the tool call itself is approved first.
  await waitForTurns(2, { until: () => prompt.isVisible() });
  const promptShownAt = Date.now();
  await screenshot("03a-panel-access-prompt-unanswered.png");
  let promptsAfterTimeout = 0;
  const unanswered = await waitForTurns(2, {
    timeout: 100_000,
    until: async () => {
      // Once the first prompt has expired, any bar is a second prompt.
      if (Date.now() - promptShownAt > 65_000 && (await prompt.isVisible())) promptsAfterTimeout++;
      return false;
    },
  });
  const waitedMs = Date.now() - promptShownAt;
  assert(waitedMs >= 50_000, `An unanswered panel request returned after only ${waitedMs} ms`);
  assert(
    /Error: The user did not grant the BrowserPanel tab/.test(unanswered.tools[0].body),
    `An unanswered panel request returned ${unanswered.tools[0].body.slice(0, 300)}`,
  );
  assert(
    /already declined or did not answer/.test(unanswered.tools[1].body),
    "A second panel request in the same turn was not refused outright",
  );
  assert(
    !unanswered.tools[2].body.includes(pageUrl),
    "An unanswered panel tab was still listed as drivable",
  );
  assert(
    promptsAfterTimeout === 0 && !(await prompt.isVisible()),
    "The panel access bar is still shown after its request timed out",
  );
  await win.getByText("fixture: panel request unanswered").first().waitFor({ timeout: 15_000 });
  await screenshot("03b-panel-access-prompt-expired.png");
  console.log(
    `acceptance: unanswered panel request declined itself after ${Math.round(waitedMs / 1000)} s; no second prompt in that turn`,
  );

  // The next user message may ask once more.
  await cli.script([{ tools: panelTools, text: "fixture: panel request denied" }]);
  await send("please use the page in my browser panel");
  // Default permission mode: the tool call itself is approved first.
  await waitForTurns(3, { until: () => prompt.isVisible() });
  await screenshot("03-panel-access-prompt.png");
  await prompt.getByRole("button", { name: /^(拒绝|Deny)$/ }).click();
  const denied = await waitForTurns(3);
  assert(/Error: /.test(denied.tools[0].body), "A denied panel request reported a grant");
  assert(
    !denied.tools[1].body.includes(pageUrl),
    "A denied panel tab was still listed as drivable",
  );
  await win.getByText("fixture: panel request denied").first().waitFor({ timeout: 15_000 });

  await cli.script([
    {
      tools: [...panelTools, { name: "browser_observe", arguments: {} }],
      text: "fixture: panel request granted",
    },
  ]);
  await send("ask again, I will allow it");
  await waitForTurns(4, { until: () => prompt.isVisible() });
  await prompt.getByRole("button", { name: /^(允许|Allow)$/ }).click();
  const granted = await waitForTurns(4);
  assert(
    /BrowserPanel tab granted/.test(granted.tools[0].body),
    "The grant did not reach the tool",
  );
  assert(granted.tools[1].body.includes(pageUrl), "The granted panel tab is not the driven tab");
  assert(/Acceptance page/.test(granted.tools[2].body), "Observation did not read the panel tab");
  await win.getByText("fixture: panel request granted").first().waitFor({ timeout: 15_000 });
  await screenshot("04-panel-access-granted.png");
  assert(
    !(await readdir(partitions)).some((name) => name.includes("external-runtime")),
    "An external-runtime partition was created",
  );
  console.log("acceptance: panel access denied then granted; granted tab is drivable");

  // --- "Allow for this session" on a Host tool is remembered for the session.
  let approveOnce = win.getByRole("button", { name: /^(仅本次批准|Approve once)$/ });
  const forSession = win.getByRole("button", {
    name: /^(本会话一直允许|Always allow this session)$/,
  });
  const listTabs = { name: "browser_act", arguments: { action: "list_tabs" } };
  let turns = (await cli.invocations()).length;
  await cli.script([
    { tools: [listTabs, listTabs], text: "fixture: allowed for the session" },
    { tools: [listTabs], text: "fixture: still allowed" },
  ]);
  await send("list the tabs twice");
  await forSession.first().waitFor({ timeout: 20_000 });
  assert(
    (await win.getByRole("button", { name: /^(选择批准范围|Select approval scope)$/ }).count()) ===
      0,
    "An external session offers an approval scope it cannot honor",
  );
  await screenshot("04b-allow-for-session-offered.png");
  await forSession.first().click();
  // The second call of the same tool in this turn, and the next turn's, never ask.
  const sameTurn = await waitForTurns(turns + 1, {
    approve: false,
    until: () => approveOnce.first().isVisible(),
  });
  assert(
    sameTurn?.tools.length === 2 && sameTurn.tools.every((tool) => !/Error: /.test(tool.body)),
    "The same tool asked again after it was allowed for the session",
  );
  await send("list them once more");
  const nextTurn = await waitForTurns(turns + 2, {
    approve: false,
    until: () => approveOnce.first().isVisible(),
  });
  assert(
    nextTurn?.tools.length === 1 && !/Error: /.test(nextTurn.tools[0].body),
    "A later turn asked again for the tool allowed for the session",
  );
  await win.getByText("fixture: still allowed").first().waitFor({ timeout: 15_000 });
  // Another tool still asks: the DriveAgent launch below waits for its own card.
  console.log("acceptance: allow-for-session kept for the same tool across turns");
  turns = (await cli.invocations()).length;

  // --- Goal questions: one banner above the composer, answered three ways.
  const ask = (args, text) => ({
    tools: [{ name: "wait_for_user", goal: true, arguments: args }],
    text,
  });
  const choice = (id, header, question, labels) => ({
    level: "preference",
    questions: [
      {
        id,
        header,
        question,
        options: labels.map((label) => ({ label, description: `${label} option` })),
      },
    ],
  });
  const banner = win.locator("[data-goal-reply]");
  const bar = () => win.locator("[data-goal-state]");
  await win.locator("button[aria-pressed]").filter({ hasText: "Goal" }).click();
  await cli.script([
    ask(choice("layout", "Layout", "Which layout should the page use?", ["Compact", "Roomy"]), ""),
    ask(choice("theme", "Theme", "Which theme should the page use?", ["Light", "Dark"]), ""),
    ask({ level: "consent", question: "Publish the page to production now?" }, ""),
  ]);
  await send("Polish the acceptance page until it is ready to publish");
  await waitForTurns(turns + 1);
  await banner.waitFor({ timeout: 20_000 });
  assert((await banner.count()) === 1, "More than one Goal question banner is shown");
  assert(
    (await banner.getAttribute("data-goal-reply-level")) === "preference" &&
      (await banner.getByRole("radio").count()) === 2 &&
      (await banner.locator("textarea, input").count()) === 0,
    "The Goal question banner is not two option cards without an input of its own",
  );
  assert((await bar().getAttribute("data-goal-state")) === "waiting", "The Goal is not waiting");
  await screenshot("05-goal-question-banner.png");
  await banner.getByRole("radio", { name: /Roomy/ }).click();
  const picked = await waitForTurns(turns + 2);
  assert(picked.prompt.includes("Roomy"), "Clicking an option did not answer the question");

  await banner.getByRole("radio", { name: /Dark/ }).waitFor({ timeout: 20_000 });
  await send("Use the dark theme, typed in the composer");
  const typed = await waitForTurns(turns + 3);
  assert(typed.prompt.includes("typed in the composer"), "A typed message did not answer");

  await win.locator('[data-goal-reply-level="consent"]').waitFor({ timeout: 20_000 });
  const consent = await banner.locator('[data-goal-reply-choice="option"]').allTextContents();
  assert(
    consent.join("|") === "同意|不同意" || consent.join("|") === "Agree|Disagree",
    `A consent question shows ${consent.join(" / ")}`,
  );
  assert((await banner.getByRole("radio").count()) === 0, "A consent question shows option cards");
  await screenshot("06-goal-consent-banner.png");

  // --- Goal state: three turns without progress stop it, with the reason shown.
  await banner.getByRole("button", { name: /^(同意|Agree)$/ }).click();
  const agreed = await waitForTurns(turns + 4);
  assert(/同意|Agree/.test(agreed.prompt), "The consent answer did not reach the runtime");
  const blocked = () => win.locator('[data-goal-state="paused"][data-goal-pause="no_progress"]');
  await blocked().waitFor({ timeout: 60_000 });
  assert(
    /目标卡住了|Goal blocked/.test(await blocked().innerText()),
    "The stopped Goal does not say why it stopped",
  );
  await screenshot("07-goal-stopped-no-progress.png");
  console.log(
    `acceptance: Goal questions answered; stopped after ${(await cli.invocations()).length} turns`,
  );

  // The reason survives an app restart on the same profile.
  await app.close();
  errors.push(...(await launch()));
  await dismissTrust();
  if (
    !(await bar()
      .isVisible()
      .catch(() => false))
  )
    await win.locator("aside").getByText("hello fixture").first().click();
  await blocked().waitFor({ timeout: 30_000 });
  assert(
    /目标卡住了|Goal blocked/.test(await blocked().innerText()),
    "After a restart the stopped Goal lost its reason",
  );
  await screenshot("08-goal-stopped-after-restart.png");

  // A message resumes a Goal that a limit stopped; the bar shows it running.
  turns = (await cli.invocations()).length;
  await selectModel();
  await cli.script([
    {
      delayMs: 4000,
      ...ask(choice("next", "Next", "What should happen next?", ["Review", "Ship"]), ""),
    },
  ]);
  await send("Keep going with the goal");
  await win
    .locator('[data-goal-state="running"], [data-goal-state="active"]')
    .waitFor({ timeout: 20_000 });
  await screenshot("09-goal-resumed-by-message.png");
  await waitForTurns(turns + 1);
  await win.locator('[data-goal-state="waiting"]').waitFor({ timeout: 20_000 });

  // A pause the user chose is theirs: a later message does not resume the Goal.
  await bar()
    .getByRole("button", { name: /^(暂停目标|Pause goal)$/ })
    .click();
  const paused = win.locator('[data-goal-state="paused"][data-goal-pause="user"]');
  await paused.waitFor({ timeout: 20_000 });
  turns = (await cli.invocations()).length;
  await cli.script([{ text: "fixture: ordinary turn while paused" }]);
  await send("A note that is not about the goal");
  await waitForTurns(turns + 1);
  await win.getByText("fixture: ordinary turn while paused").first().waitFor({ timeout: 15_000 });
  await new Promise((done) => setTimeout(done, 4000));
  assert(
    (await cli.invocations()).length === turns + 1,
    "A user-paused Goal continued on its own after a message",
  );
  assert(await paused.isVisible(), "A user-paused Goal was resumed by a message");
  await screenshot("10-goal-user-pause-kept.png");
  console.log("acceptance: stop reason survived restart; message resumed it; user pause kept");

  // --- DriveAgent: a background Codex worker that needs an approval.
  turns = (await cli.invocations()).length;
  await cli.script([
    {
      tools: [
        {
          name: "DriveAgent",
          arguments: {
            title: "Acceptance worker task",
            prompt: "Commit the acceptance change",
            cli: "codex",
            permissionMode: "default",
          },
        },
      ],
      text: "fixture: worker launched",
    },
  ]);
  // Back to the default permission mode, so the worker's request is asked.
  await win.getByRole("button", { name: /完全访问权限|Full access/ }).click();
  await win.getByRole("option", { name: /默认权限|Default/ }).click();
  await send("Hand the commit to a Codex worker");
  // The window was replaced by the restart above.
  approveOnce = win.getByRole("button", { name: /^(仅本次批准|Approve once)$/ });
  await approveOnce.first().click();
  const launched = await waitForTurns(turns + 1, { approve: false });
  assert(!/"isError":true/.test(launched.tools[0].body), "DriveAgent did not launch the worker");
  // The worker's own request arrives in this session, named after its task.
  const workerApproval = win.getByText(/Requested by background task «Acceptance worker task»/);
  await workerApproval.waitFor({ timeout: 20_000 });
  await win
    .getByText(/^(执行过程|Process)$/)
    .last()
    .click();
  await win
    .getByRole("button", { name: /查看 .*进度|View .* progress/ })
    .first()
    .click();
  const task = win.getByRole("region", { name: /任务进度|Task progress/ });
  const awaiting = task.locator('[data-drive-agent-permission="awaiting"]');
  await awaiting.waitFor({ timeout: 20_000 });
  assert(
    (await task.getByText("Acceptance worker task", { exact: true }).count()) > 0 &&
      /等待你在原会话里审批|Waiting for your approval/.test(await awaiting.innerText()) &&
      (await task.locator("[data-drive-agent-status]").getAttribute("data-drive-agent-status")) ===
        "running",
    "The worker task view does not show its title and the pending approval",
  );
  await screenshot("11-worker-awaiting-approval.png");

  // Cancelling the worker withdraws its approval card from the parent session.
  await task.getByRole("button", { name: /^(停止|Stop)$/ }).click();
  await workerApproval.waitFor({ state: "hidden", timeout: 20_000 });
  await task
    .locator('[data-drive-agent-status="cancelled"]')
    .waitFor({ timeout: 20_000 })
    .catch(() => undefined);
  const workerEvents = await cli.codexEvents();
  const worker = workerEvents.map(
    (event) => event.event + (event.answer ? `=${event.answer.decision}` : ""),
  );
  assert(
    !worker.includes("approval=accept") && (await approveOnce.count()) === 0,
    `A cancelled worker left its approval behind (${worker.join(", ")})`,
  );
  // The worker's inline row in the parent session follows it to the end state.
  const row = win.locator("[data-drive-agent-progress]");
  await row
    .first()
    .waitFor({ timeout: 10_000 })
    .catch(() => undefined);
  const rowDeadline = Date.now() + 10_000;
  const rowStatus = () => row.first().getAttribute("data-drive-agent-progress");
  while ((await rowStatus()) !== "cancelled" && Date.now() < rowDeadline)
    await new Promise((done) => setTimeout(done, 200));
  assert(
    (await rowStatus()) === "cancelled" && /已取消|Cancelled/i.test(await row.first().innerText()),
    `The parent session's worker row still reads ${await row.first().innerText()}`,
  );
  await screenshot("12-worker-cancelled-approval-gone.png");
  console.log(
    `acceptance: worker task showed its title and pending approval; cancel withdrew the card (${worker.join(", ")})`,
  );

  assert(errors.length === 0, `Renderer errors: ${errors.map((e) => e.message).join("; ")}`);
  console.log("CodeShell external session acceptance: passed");
} catch (error) {
  await screenshot("failure.png").catch(() => undefined);
  if (cli) console.error(JSON.stringify(await cli.invocations().catch(() => [])).slice(0, 6000));
  throw error;
} finally {
  await app?.close().catch(() => undefined);
  await new Promise((done) => (page ? page.close(done) : done()));
  await isolated.cleanup();
}
