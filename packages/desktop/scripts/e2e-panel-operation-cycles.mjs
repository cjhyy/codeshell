/* Real Electron panel operations against owned files, Git repositories and HTTP.
 * The native folder picker is controlled; panel actions use production UI/IPC. */
/* global document, window */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareConfinedElectronFixture } from "./confined-electron-fixture.mjs";
import { watchElectronTestProcess } from "./electron-test-watchdog.mjs";
import {
  assertSourceElectronTransportSettled,
  expandSidebar,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
  seedSessionCatalog,
} from "./electron-harness.mjs";

assert.ok(process.env.CODE_SHELL_TEST_HOME, "Run through run-isolated-node-smoke.mjs");
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceArgs = process.argv.slice(2);
assert.ok(
  evidenceArgs.length === 0 ||
    (evidenceArgs.length === 2 && evidenceArgs[0] === "--evidence-dir" && evidenceArgs[1]),
  "Expected no arguments or --evidence-dir <new-owned-directory>",
);
const evidence = evidenceArgs.length
  ? join(await realpath(dirname(resolve(evidenceArgs[1]))), basename(resolve(evidenceArgs[1])))
  : await mkdtemp(join(tmpdir(), "codeshell-panel-operation-evidence-"));
const evidenceRelative = relative(appDir, evidence);
assert.ok(
  evidenceRelative === ".." ||
    evidenceRelative.startsWith(`..${sep}`) ||
    isAbsolute(evidenceRelative),
  "Evidence must remain outside Desktop",
);
if (evidenceArgs.length) await mkdir(evidence, { mode: 0o700 });
const isolated = await makeIsolatedElectronHome("codeshell-panel-operation-cycles-");
const projectPath = join(isolated.home, "operation-project");
const secondaryPath = join(isolated.home, "secondary-folder");
const sessionId = "panel-operation-session";
const title = "Panel operation conversation";
const report = { cases: [], errors: [], evidence };
let electron, win, failure, processMonitor, mainChild, mainClosed;
let routeAvailable = false;
const requests = [];
const server = createServer((request, response) => {
  requests.push(request.url);
  if (request.url === "/retry" && !routeAvailable) {
    request.socket.destroy();
    return;
  }
  const name =
    request.url === "/b"
      ? "Fixture B"
      : request.url === "/background"
        ? "Fixture Background"
        : request.url === "/idle"
          ? "Fixture Idle"
          : "Fixture A";
  response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
  response.end(
    `<!doctype html><title>${name}</title><style>body{margin:20px}input{display:block;margin-top:20px}</style><h1>${name}</h1><a href="/b">Next fixture page</a><input id="draft" aria-label="Page draft" placeholder="Page draft"><p>Owned browser fixture</p>`,
  );
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const confined = await prepareConfinedElectronFixture({ appDir, isolated, origin });

async function dismissTrust() {
  const button = win.getByRole("button", { name: /^(仅查看|View only)/ });
  if (
    await button.waitFor({ state: "visible", timeout: 2000 }).then(
      () => true,
      () => false,
    )
  )
    await button.click();
}
async function openPanel(kind) {
  const toggle = win.locator('[data-panel-action="toggle"]');
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  const slot = win.locator(`[data-panel-id="${kind}"]`);
  if (await slot.count()) {
    const id = await slot.getAttribute("aria-labelledby");
    await win.locator(`[id="${id}"]`).click();
  } else {
    await win.locator('[data-panel-action="new-tab"]').click();
    await win.locator(`[data-panel-menu-kind="${kind}"]`).click();
  }
  await win.locator(`[data-panel-id="${kind}"][data-panel-active="true"]`).waitFor();
  return win.locator(`[data-panel-id="${kind}"][data-panel-active="true"]`);
}
const activeGuest = () =>
  win.locator('[data-panel-id="browser"][data-panel-active="true"] webview:visible');
async function guestValue(expression) {
  return activeGuest().evaluate(
    (node, expression) => node.executeJavaScript(expression),
    expression,
  );
}
async function navigate(url, expectedTitle) {
  const browser = await openPanel("browser");
  const address = browser.locator('input[placeholder*="URL"]');
  await address.fill(url);
  await address.press("Enter");
  if (expectedTitle) {
    await browser.getByRole("button", { name: expectedTitle, exact: true }).waitFor();
    await win.waitForFunction((title) => {
      const view = [...document.querySelectorAll('[data-panel-id="browser"] webview')].find(
        (node) => node.getClientRects().length,
      );
      try {
        return view?.getTitle() === title && !view.isLoading();
      } catch {
        return false;
      }
    }, expectedTitle);
  }
  return browser;
}
async function seed() {
  await mkdir(join(projectPath, "nested"), { recursive: true });
  await mkdir(secondaryPath, { recursive: true });
  await writeFile(join(secondaryPath, "secondary.txt"), "secondary folder actual content\n");
  await mkdir(join(isolated.codeShellHome, "desktop"), { recursive: true });
  await writeFile(join(projectPath, "alpha.txt"), "first content\n");
  await writeFile(join(projectPath, "nested", "deep.txt"), "deep file content\n");
  await writeFile(join(projectPath, "README.md"), "# Fixture document\n\nReadable markdown.\n");
  await writeFile(join(projectPath, "报告.md"), "owned Unicode mention content\n");
  await mkdir(join(projectPath, "a-long-directory"));
  await writeFile(
    join(projectPath, "a-long-directory", "needle-document.md"),
    "owned primary-root mention content\n",
  );
  await Promise.all(
    Array.from({ length: 30 }, (_, index) =>
      writeFile(join(secondaryPath, `needle-${String(index).padStart(2, "0")}.md`), "other root\n"),
    ),
  );
  const git = (...args) => execFileSync("git", args, { cwd: projectPath, stdio: "pipe" });
  git("init", "-b", "main");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@localhost",
    "commit",
    "-m",
    "Fixture initial commit",
  );
  await writeFile(join(projectPath, "alpha.txt"), "updated content\n");
  await writeFile(
    join(isolated.codeShellHome, "desktop", "recents.json"),
    JSON.stringify([{ path: projectPath, name: "operation-project", lastOpenedAt: Date.now() }]),
  );
  await writeFile(
    join(isolated.codeShellHome, "settings.json"),
    JSON.stringify({ autoUpdates: false }),
  );
}
try {
  await seed();
  electron = await launchCodeShellElectron(
    {
      appDir,
      home: isolated.home,
      userDataDir: isolated.userDataDir,
      mainEntry: confined.mainEntry,
      env: confined.env,
    },
    {
      watch: (child, options) => {
        assert.equal(mainChild, undefined, "One direct Main per panel fixture");
        mainChild = child;
        mainClosed = new Promise((done) =>
          child.once("close", (code, signal) => done({ code, signal })),
        );
        processMonitor = watchElectronTestProcess(child, options);
        return processMonitor;
      },
      reportFailure: (message) => report.errors.push(message),
    },
  );
  win = await findCodeShellWindow(electron);
  win.setDefaultTimeout(15_000);
  win.on("pageerror", (error) => report.errors.push(error.message));
  await win.setViewportSize({ width: 1280, height: 850 });
  await dismissTrust();
  await win.evaluate((cwd) => window.codeshell.setTrust(cwd, "trusted"), projectPath);
  await win.getByText("operation-project", { exact: true }).first().click();
  await dismissTrust();
  const project = await win.evaluate(
    async (cwd) =>
      (await window.codeshell.projectRegistry.list()).find((item) =>
        item.roots.some((root) => root.path === cwd),
      ),
    projectPath,
  );
  assert.ok(project?.id);
  await electron.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, secondaryPath);
  const multiRootProject = await win.evaluate(
    (id) => window.codeshell.projectRegistry.addRootFromPicker(id),
    project.id,
  );
  assert.equal(multiRootProject.project.roots.length, 2);
  const folder = join(isolated.codeShellHome, "sessions", sessionId);
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, "state.json"),
    JSON.stringify({
      sessionId,
      title,
      cwd: projectPath,
      project: { projectId: project.id, mainRootId: project.primaryRootId },
      origin: "desktop",
      kind: "work",
      parentSessionId: null,
      status: "completed",
      startedAt: Date.now(),
    }),
  );
  await writeFile(
    join(folder, "transcript.jsonl"),
    [
      { type: "session_meta", data: { sessionId } },
      {
        type: "message",
        data: { role: "user", content: title, clientMessageId: `${sessionId}-input` },
      },
    ]
      .map((event, index) =>
        JSON.stringify({
          id: `${sessionId}-${index}`,
          timestamp: Date.now() + index,
          turnNumber: 1,
          ...event,
        }),
      )
      .join("\n") + "\n",
  );
  await seedSessionCatalog(win, {
    [project.id]: {
      sessions: [
        {
          id: sessionId,
          engineSessionId: sessionId,
          title,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      activeSessionId: null,
    },
  });
  await win.reload();
  await dismissTrust();
  await expandSidebar(win);
  await win.getByRole("button", { name: title, exact: true }).click();
  await dismissTrust();
  report.confinement = await confined.assertWorker(electron, { requireWorker: false });
  const composer = win.locator('textarea[aria-autocomplete="list"]:visible');
  for (const [query, name, path, content] of [
    ["报告", "报告.md", join(projectPath, "报告.md"), "owned Unicode mention content\n"],
    [
      "needle",
      "needle-document.md",
      join(projectPath, "a-long-directory", "needle-document.md"),
      "owned primary-root mention content\n",
    ],
  ]) {
    await composer.fill(`@${query}`);
    await composer.press("End");
    await win.getByRole("option").filter({ hasText: name }).click();
    await win.waitForFunction(
      (expected) =>
        document
          .querySelector('textarea[aria-autocomplete="list"]')
          ?.value.replaceAll("\\", "/") === `@${expected.replaceAll("\\", "/")} `,
      path,
    );
    assert.equal(await readFile(path, "utf8"), content);
    await composer.fill("");
    await composer.press("Escape");
    report.cases.push(`Composer @${query} selects the readable file in its authoritative root`);
  }
  await win.evaluate(() => {
    window.__panelOperationAnchors = [];
    window.addEventListener("codeshell:add-anchor", (event) =>
      window.__panelOperationAnchors.push(event.detail.anchor),
    );
  });

  const files = await openPanel("files");
  const alpha = files.locator("[data-files-path]").filter({ hasText: "alpha.txt" });
  await alpha.click();
  await files.getByText("updated content", { exact: true }).waitFor();
  await rename(join(projectPath, "alpha.txt"), join(projectPath, "alpha-hidden.txt"));
  await files.getByRole("button", { name: "刷新", exact: true }).last().click();
  await files.getByText(/读取失败|Failed to read/).waitFor();
  await rename(join(projectPath, "alpha-hidden.txt"), join(projectPath, "alpha.txt"));
  await files.getByRole("button", { name: "刷新", exact: true }).last().click();
  await files.getByText("updated content", { exact: true }).waitFor();
  report.cases.push(
    "Files opens real project content, exposes deleted-file failure and refresh recovers it",
  );
  await files.getByRole("button", { name: /返回文件|Back to files/ }).click();
  await files.locator("input").fill("README");
  await files.locator("[data-files-path]").filter({ hasText: "README.md" }).click();
  await files.getByRole("heading", { name: "Fixture document" }).waitFor();
  report.cases.push("Files filter and Markdown preview use owned project files");
  await files.getByRole("button", { name: /返回文件|Back to files/ }).click();
  await files.locator("input").fill("");
  await files.getByRole("combobox", { name: "项目文件夹", exact: true }).click();
  await win.getByRole("option", { name: /secondary-folder/ }).click();
  await files.locator("[data-files-path]").filter({ hasText: "secondary.txt" }).click();
  await files.getByText("secondary folder actual content", { exact: true }).waitFor();
  await files.getByRole("button", { name: /返回文件|Back to files/ }).click();
  await files.getByRole("combobox", { name: "项目文件夹", exact: true }).click();
  await win.getByRole("option", { name: /operation-project/ }).click();
  await files.locator("[data-files-path]").filter({ hasText: "alpha.txt" }).click();
  await files.getByText("updated content", { exact: true }).waitFor();
  assert.equal(
    await files.getByText("secondary folder actual content", { exact: true }).count(),
    0,
  );
  report.cases.push(
    "Files real registered secondary-root selection reads its scoped files and switching back clears stale content",
  );
  await files.getByRole("button", { name: "评论此行", exact: true }).first().click();
  const fileComment = files.getByRole("textbox", { name: "本地评论 · alpha.txt:1", exact: true });
  await fileComment.fill("Canceled file comment");
  await fileComment.press("Escape");
  await fileComment.waitFor({ state: "hidden" });
  assert.equal(await win.evaluate(() => window.__panelOperationAnchors.length), 0);
  await files.getByRole("button", { name: "评论此行", exact: true }).first().click();
  await fileComment.fill("Owned file line comment");
  await files.getByRole("button", { name: "添加到输入框", exact: true }).click();
  const fileAnchor = await win.evaluate(() => window.__panelOperationAnchors[0]);
  assert.equal(fileAnchor.locator["文件"], join(projectPath, "alpha.txt"));
  assert.equal(fileAnchor.locator["行号"], "1");
  const fileChip = win.locator('[title^="Owned file line comment"]');
  await fileChip.getByRole("button", { name: "移除标注", exact: true }).click();
  await fileChip.waitFor({ state: "hidden" });
  report.cases.push(
    "Files line-comment Escape cancels; adding pins the exact file and line to the composer and removal clears it",
  );

  const browser = await navigate(`${origin}/a`, "Fixture A");
  await navigate(`${origin}/b`, "Fixture B");
  await browser.getByRole("button", { name: "后退", exact: true }).click();
  await browser.getByRole("button", { name: "Fixture A", exact: true }).waitFor();
  await browser.getByRole("button", { name: "前进", exact: true }).click();
  await browser.getByRole("button", { name: "Fixture B", exact: true }).waitFor();
  await win.waitForFunction(() => {
    const view = document.querySelector(
      '[data-panel-id="browser"][data-panel-active="true"] webview',
    );
    try {
      return view?.getURL().endsWith("/b") && !view.isLoading();
    } catch {
      return false;
    }
  });
  const inputRect = await guestValue(
    "JSON.parse(JSON.stringify(document.getElementById('draft').getBoundingClientRect()))",
  );
  await activeGuest().click({
    position: { x: inputRect.x + 10, y: inputRect.y + inputRect.height / 2 },
  });
  await win.keyboard.type("Keep this browser draft");
  assert.equal(
    await guestValue("document.getElementById('draft').value"),
    "Keep this browser draft",
  );
  const guestId = await activeGuest().evaluate((node) => node.getWebContentsId());
  const beforeSwitchRequests = requests.length;
  await browser.getByRole("button", { name: "新选项卡", exact: true }).last().click();
  await browser.getByRole("button", { name: "Fixture B", exact: true }).click();
  await win.waitForFunction(() => {
    const view = [...document.querySelectorAll('[data-panel-id="browser"] webview')].find(
      (node) => node.getClientRects().length,
    );
    try {
      return !!view?.getURL() && !view.isLoading();
    } catch {
      return false;
    }
  });
  const afterSwitch = {
    guestId: await activeGuest().evaluate((node) => node.getWebContentsId()),
    draft: await guestValue("document.getElementById('draft').value"),
    canGoBack: await activeGuest().evaluate((node) => node.canGoBack()),
    requests: requests.length - beforeSwitchRequests,
  };
  await writeFile(
    join(evidence, "browser-switch.json"),
    JSON.stringify(
      {
        before: { guestId, draft: "Keep this browser draft", canGoBack: true },
        after: afterSwitch,
      },
      null,
      2,
    ),
  );
  assert.equal(
    afterSwitch.guestId,
    guestId,
    "Switching browser tabs must retain the original guest",
  );
  assert.equal(
    afterSwitch.draft,
    "Keep this browser draft",
    "Switching browser tabs must preserve unsent page inputs",
  );
  assert.equal(
    afterSwitch.canGoBack,
    true,
    "Switching browser tabs must retain navigation history",
  );
  assert.equal(afterSwitch.requests, 0, "Switching browser tabs must not reload the retained page");
  report.cases.push(
    "Browser back/forward and tab switching preserve guest, page draft and navigation history",
  );
  report.browserLayouts = [];
  for (const width of [390, 768, 1280]) {
    await win.setViewportSize({ width, height: 850 });
    await win.waitForFunction((width) => window.innerWidth === width, width);
    const layout = await browser.evaluate((node) => {
      const field = node.querySelector('input[placeholder*="URL"]');
      return {
        panelWidth: node.clientWidth,
        scrollWidth: node.scrollWidth,
        addressWidth: field.getBoundingClientRect().width,
      };
    });
    report.browserLayouts.push({ viewport: width, ...layout });
    await win.screenshot({ path: join(evidence, `browser-${width}.png`) });
    assert.ok(layout.panelWidth <= width, "A dock must fit the current viewport");
    assert.ok(layout.addressWidth >= 120, "The narrow browser address must remain usable");
  }
  await writeFile(
    join(evidence, "browser-layouts.json"),
    JSON.stringify(report.browserLayouts, null, 2),
  );
  const pickButton = browser.getByRole("button", { name: "圈选元素(加入输入框)", exact: true });
  async function pickHeading() {
    await pickButton.click();
    const rect = await guestValue(
      "JSON.parse(JSON.stringify(document.querySelector('h1').getBoundingClientRect()))",
    );
    await activeGuest().click({ position: { x: rect.x + 10, y: rect.y + rect.height / 2 } });
    await browser.getByRole("textbox", { name: "本地评论 · h1", exact: true }).waitFor();
  }
  await pickHeading();
  const browserComment = browser.getByRole("textbox", { name: "本地评论 · h1", exact: true });
  await browserComment.fill("Canceled browser comment");
  await browserComment.press("Escape");
  await browserComment.waitFor({ state: "hidden" });
  assert.equal(await win.evaluate(() => window.__panelOperationAnchors.length), 1);
  await pickButton.click();
  await browser.getByRole("button", { name: "新选项卡", exact: true }).first().click();
  await browser.getByRole("button", { name: "Fixture B", exact: true }).click();
  await pickButton.waitFor();
  await pickHeading();
  await browserComment.fill("Owned browser element comment");
  await browser.getByRole("button", { name: "添加到输入框", exact: true }).click();
  const browserAnchor = await win.evaluate(() => window.__panelOperationAnchors[1]);
  assert.equal(browserAnchor.locator["网址"], `${origin}/b`);
  assert.equal(browserAnchor.locator["元素"], "h1");
  await browser.getByTitle("Owned browser element comment", { exact: true }).click();
  await browser.getByPlaceholder("评论…", { exact: true }).fill("Updated browser element comment");
  await browser.getByRole("button", { name: "保存", exact: true }).click();
  await browser.getByTitle("Updated browser element comment", { exact: true }).waitFor();
  await browser.getByRole("button", { name: "删除", exact: true }).click();
  await browser
    .getByTitle("Updated browser element comment", { exact: true })
    .waitFor({ state: "hidden" });
  assert.equal(await win.getByRole("button", { name: "移除标注", exact: true }).count(), 0);
  report.cases.push(
    "Browser real element picking cancels on Escape/tab switch; saved marker carries the exact page and supports edit/save/delete",
  );
  await browser.locator('input[placeholder*="URL"]').fill("Keep A address while opening B");
  await browser.getByRole("button", { name: "新选项卡", exact: true }).last().click();
  await navigate(`${origin}/idle`, "Fixture Idle");
  await browser.getByRole("button", { name: "关闭标签", exact: true }).last().click();
  await browser.getByRole("button", { name: "Fixture B", exact: true }).click();
  assert.equal(
    await browser.locator('input[placeholder*="URL"]').inputValue(),
    "Keep A address while opening B",
    "Opening and closing another live guest must preserve this tab's unsubmitted address draft",
  );
  report.cases.push(
    "Browser opening and closing another live tab preserves the first tab's unsubmitted address draft",
  );
  await navigate(`${origin}/retry`);
  await browser.getByRole("button", { name: "重试", exact: true }).waitFor();
  routeAvailable = true;
  await browser.getByRole("button", { name: "重试", exact: true }).click();
  await browser.getByRole("button", { name: "Fixture A", exact: true }).waitFor();
  report.cases.push("Browser real connection failure shows Retry and recovers on the owned server");

  // A retained background page may redirect or change its title. The active
  // tab keeps its own address and history while the hidden tab records them.
  await browser.getByRole("button", { name: "新选项卡", exact: true }).last().click();
  await navigate(`${origin}/b`, "Fixture B");
  const secondGuestId = await activeGuest().evaluate((node) => node.getWebContentsId());
  await electron.evaluate(({ webContents }, { id, url }) => webContents.fromId(id).loadURL(url), {
    id: guestId,
    url: `${origin}/background`,
  });
  await browser.getByRole("button", { name: "Fixture Background", exact: true }).waitFor();
  assert.equal(await browser.locator('input[placeholder*="URL"]').inputValue(), `${origin}/b`);
  assert.equal(await activeGuest().evaluate((node) => node.getWebContentsId()), secondGuestId);
  await browser.getByRole("button", { name: "Fixture Background", exact: true }).click();
  assert.equal(await activeGuest().evaluate((node) => node.getWebContentsId()), guestId);
  assert.equal(
    await browser.locator('input[placeholder*="URL"]').inputValue(),
    `${origin}/background`,
  );
  report.cases.push(
    "Browser background navigation updates its own tab without replacing the active page",
  );
  await browser.getByRole("button", { name: "关闭标签", exact: true }).first().click();
  await win.waitForFunction(
    (id) =>
      ![...document.querySelectorAll('[data-panel-id="browser"] webview')].some((node) => {
        try {
          return node.getWebContentsId() === id;
        } catch {
          return false;
        }
      }),
    guestId,
  );
  assert.equal(await activeGuest().evaluate((node) => node.getWebContentsId()), secondGuestId);
  report.cases.push(
    "Closing the selected browser tab destroys its guest and selects the surviving tab",
  );

  // Advance only the owned renderer's clock to exercise the production idle
  // policy without holding a release audit open for five real minutes.
  await win.clock.install();
  await browser.getByRole("button", { name: "新选项卡", exact: true }).last().click();
  await navigate(`${origin}/idle`, "Fixture Idle");
  await browser.locator('input[placeholder*="URL"]').fill("Keep the pending address draft");
  await win.clock.fastForward(5 * 60 * 1000 + 1);
  await win.waitForFunction(
    (id) =>
      ![...document.querySelectorAll('[data-panel-id="browser"] webview')].some((node) => {
        try {
          return node.getWebContentsId() === id;
        } catch {
          return false;
        }
      }),
    secondGuestId,
  );
  assert.equal(
    await browser.locator('input[placeholder*="URL"]').inputValue(),
    "Keep the pending address draft",
    "Reclaiming a background guest cannot overwrite the current address draft",
  );
  await browser.getByRole("button", { name: "Fixture B", exact: true }).click();
  await win.waitForFunction((url) => {
    const view = [...document.querySelectorAll('[data-panel-id="browser"] webview')].find(
      (node) => node.getClientRects().length,
    );
    try {
      return view?.getURL() === url && !view.isLoading();
    } catch {
      return false;
    }
  }, `${origin}/b`);
  assert.notEqual(await activeGuest().evaluate((node) => node.getWebContentsId()), secondGuestId);
  await navigate(`${origin}/a`, "Fixture A");
  await browser.getByRole("button", { name: "后退", exact: true }).click();
  await browser.getByRole("button", { name: "Fixture B", exact: true }).waitFor();
  report.cases.push(
    "Browser five-minute idle eviction frees the hidden guest and remount restores working navigation listeners",
  );
  await win.clock.resume();

  const review = await openPanel("review");
  await review.getByText("updated content", { exact: true }).waitFor();
  execFileSync("git", ["add", "alpha.txt"], { cwd: projectPath });
  await review.getByRole("button", { name: "选择审查范围", exact: true }).click();
  await win.getByRole("menuitem", { name: "已暂存", exact: true }).click();
  await review.getByText("updated content", { exact: true }).waitFor();
  report.cases.push("Review reads actual working and staged Git diffs");
  const indexPath = join(projectPath, ".git", "index");
  const indexBytes = await readFile(indexPath);
  await writeFile(indexPath, "broken fixture index");
  await review.getByRole("button", { name: "刷新", exact: true }).click();
  await review.getByText(/index file|bad index|index.*corrupt/).waitFor();
  await writeFile(indexPath, indexBytes);
  await review.getByRole("button", { name: "刷新", exact: true }).click();
  await review.getByText("updated content", { exact: true }).waitFor();
  report.cases.push(
    "Review exposes a real corrupted-index error and refresh recovers after repair",
  );
  await review.getByRole("button", { name: "选择审查范围", exact: true }).click();
  await win.getByRole("menuitem", { name: "提交", exact: true }).hover();
  await win.getByRole("menuitem", { name: /Fixture initial commit/ }).click();
  await review.getByText("first content", { exact: true }).waitFor();
  report.cases.push(
    "Review selected root commit displays its real additions instead of an empty diff",
  );

  const terminal = await openPanel("terminal");
  const input = terminal.locator(".xterm-helper-textarea");
  await input.focus();
  await win.keyboard.type("printf 'PANEL_OPERATION_PTY_OK\\n'\n");
  await terminal.getByText("PANEL_OPERATION_PTY_OK", { exact: true }).waitFor();
  await openPanel("files");
  await openPanel("terminal");
  await terminal.getByText("PANEL_OPERATION_PTY_OK", { exact: true }).waitFor();
  report.cases.push("Terminal executes real PTY input and preserves output across panel switches");
  await input.focus();
  await win.keyboard.type("printf 'PANEL_OPERATION_SLEEP_STARTED\\n'; sleep 60\n");
  await terminal.getByText("PANEL_OPERATION_SLEEP_STARTED", { exact: true }).waitFor();
  await win.keyboard.press("Control+C");
  await win.waitForFunction(() => {
    const rows = document.querySelector(
      '[data-panel-id="terminal"][data-panel-active="true"] .xterm-rows',
    );
    return /[%$#>]\s*$/.test(rows?.textContent ?? "");
  });
  await win.keyboard.type("printf 'PANEL_OPERATION_CANCEL_OK\\n'\n");
  await terminal.getByText("PANEL_OPERATION_CANCEL_OK", { exact: true }).waitFor();
  await win.keyboard.type("exit\n");
  await terminal.getByText(/进程已退出/).waitFor();
  const terminalLabel = await terminal.getAttribute("aria-labelledby");
  await win
    .locator(`[id="${terminalLabel}"]`)
    .locator("..")
    .getByRole("button", { name: "关闭标签: 终端", exact: true })
    .click();
  const replacement = await openPanel("terminal");
  await replacement.locator(".xterm-helper-textarea").focus();
  await win.keyboard.type("printf 'PANEL_OPERATION_REOPEN_OK\\n'\n");
  await replacement.getByText("PANEL_OPERATION_REOPEN_OK", { exact: true }).waitFor();
  report.cases.push(
    "Terminal Ctrl+C cancels a real process; exit and reopening starts a fresh usable PTY",
  );
  assert.deepEqual(report.errors, []);
  report.result = "pass";
} catch (error) {
  failure = error;
  report.result = "fail";
  report.failure = error.stack;
  await win?.screenshot({ path: join(evidence, "failure.png") }).catch(() => {});
  await writeFile(
    join(evidence, "body.txt"),
    (await win
      ?.locator("body")
      .innerText()
      .catch(() => "unavailable")) ?? "unavailable",
  );
} finally {
  let closeTimer;
  try {
    if (electron) {
      assert.ok(processMonitor, "No birth custody: unsafe ordinary close skipped");
      await Promise.race([
        electron.close(),
        new Promise((_, reject) => {
          closeTimer = setTimeout(() => reject(Error("Owned panel close timed out")), 8000);
        }),
      ]);
    }
  } catch (error) {
    report.errors.push(error.message);
    failure ??= error;
  } finally {
    clearTimeout(closeTimer);
  }
  try {
    report.processSettlement = (await processMonitor?.terminate()) ?? null;
    assert.equal(
      report.processSettlement?.status,
      "cleaned",
      "Process exit unproven; HOME retained",
    );
    assert.equal(report.processSettlement.queryFailed, false);
    assert.equal(report.processSettlement.remainingCount, 0);
    let exitTimer;
    try {
      assert.ok(mainClosed, "Direct Main close event was not captured");
      report.mainExit = await Promise.race([
        mainClosed,
        new Promise((_, reject) => {
          exitTimer = setTimeout(() => reject(Error("Owned Main close event unavailable")), 3000);
        }),
      ]);
    } finally {
      clearTimeout(exitTimer);
    }
    assert.deepEqual(report.mainExit, { code: 0, signal: null });
    report.windowsTransport = assertSourceElectronTransportSettled(mainChild);
    assert.deepEqual(
      report.errors,
      [],
      "Late renderer/transport/close failure must fail acceptance",
    );
    await isolated.cleanup();
    report.privateHomeRemoved = true;
  } catch (error) {
    report.errors.push(error.message);
    report.retainedHome = isolated.home;
    failure ??= error;
    mainChild?.unref();
    mainChild?.stdout?.unref?.();
    mainChild?.stderr?.unref?.();
  }
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  if (failure) {
    report.result = "fail";
    report.failure ??= failure.stack;
  }
  await writeFile(join(evidence, "report.json"), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
if (failure) throw failure;
