/* Actual companion renderer → production chat IPC → actual Pet worker.
 * Replies come only from a local mock model. This does not certify CUA input
 * or compositor visibility. Build Desktop first, then use the isolated runner:
 * node scripts/run-isolated-node-smoke.mjs --private-keyring packages/desktop/scripts/e2e-mimi-companion-chat.mjs
 * --keep-open retains this owned application for manual native/CUA checks.
 */
/* global window, document */
import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { prepareConfinedElectronFixture } from "./confined-electron-fixture.mjs";
import {
  assertOfflinePluginBootstrapHeld,
  captureRendererErrors,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
  seedOfflinePluginBootstrap,
} from "./electron-harness.mjs";
import { watchElectronTestProcess } from "./electron-test-watchdog.mjs";
import { startMockProviderServer } from "./mock-provider-server.mjs";

assert.equal(process.platform, "darwin", "The current desktop companion requires macOS");
assert.equal(
  process.env.CODE_SHELL_TEST_HOME,
  join(process.env.HOME, ".code-shell"),
  "Use scripts/run-isolated-node-smoke.mjs so the fixture never inherits provider credentials",
);
const args = process.argv.slice(2);
const flags = new Set();
const options = new Map();
for (let index = 0; index < args.length; index++) {
  const flag = args[index];
  if (["--keep-open", "--right-display"].includes(flag)) {
    assert.ok(!flags.has(flag), `Duplicate ${flag}`);
    flags.add(flag);
  } else {
    assert.ok(["--receipt", "--cua-driver"].includes(flag), `Unknown option ${flag}`);
    const value = args[++index];
    assert.ok(value && !value.startsWith("--") && !options.has(flag), `Missing value for ${flag}`);
    options.set(flag, resolve(value));
  }
}
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const file of [
  "out/main/index.mjs",
  "out/preload/mimi-companion.cjs",
  "out/renderer/mimi-companion.html",
])
  await access(join(appDir, file)).catch(() => {
    throw Error(`Missing ${file}; build the workspace and Desktop before this acceptance run`);
  });
const isolated = await makeIsolatedElectronHome("codeshell-companion-chat-");
const receiptPath = options.get("--receipt") ?? join(appDir, "out", `mimi-chat-${Date.now()}.json`);
const receipt = {
  schemaVersion: 1,
  model: "local mock provider; no real model credentials",
  boundary:
    "Production app, companion, chat IPC and worker; scripted DOM interaction is not native hit testing or CUA/compositor acceptance",
  home: isolated.home,
  userData: isolated.userDataDir,
  passed: false,
  checks: [],
};
let model, app, monitor, guardTimer, stdin;
let main;
let mainStderr = "";
let guardRunning = false;
let guardFailure;
let verifiedWorkers = "";
let guardWork = Promise.resolve();
let stopKeepingOpen;
const rendererErrors = [];
const put = async (path, value) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 });
};
const bounded = async (promise, ms, label) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(label)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const requestStop = () => stopKeepingOpen?.();
process.on("SIGINT", requestStop);
process.on("SIGTERM", requestStop);

try {
  model = await startMockProviderServer();
  const fixture = await prepareConfinedElectronFixture({ appDir, isolated, origin: model.origin });
  await seedOfflinePluginBootstrap(isolated.codeShellHome);
  await put(join(isolated.codeShellHome, "settings.json"), {
    autoUpdates: false,
    featureFlags: { computer_use_cua: options.has("--cua-driver") },
    credentials: [
      { id: "local-mock", catalogId: "deepseek", apiKey: "synthetic", baseUrl: model.baseUrl },
    ],
    modelConnections: [
      {
        id: "local-mock",
        catalogId: "deepseek",
        tag: "text",
        model: "deepseek-v4-flash",
        credentialId: "local-mock",
      },
    ],
    defaults: { text: "local-mock" },
  });
  app = await launchCodeShellElectron(
    {
      appDir,
      home: isolated.home,
      userDataDir: isolated.userDataDir,
      mainEntry: fixture.mainEntry,
      env: {
        ...fixture.env,
        ...(options.has("--cua-driver")
          ? { CODESHELL_CUA_DRIVER_PATH: options.get("--cua-driver") }
          : {}),
      },
      runtimeTimeoutMs: flags.has("--keep-open") ? 31 * 60_000 : 180_000,
    },
    {
      watch: (child, settings) => (monitor = watchElectronTestProcess(child, settings)),
    },
  );
  receipt.mainPid = app.process().pid;
  app.process().stderr?.on("data", (data) => {
    mainStderr = (mainStderr + data.toString()).slice(-12_000);
  });
  await findCodeShellWindow(app);
  main = app.windows().find((page) => {
    const url = new URL(page.url());
    return url.pathname.endsWith("/renderer/index.html") && !url.searchParams.has("popout");
  });
  assert.ok(main, "Actual production workbench was not found");
  rendererErrors.push(captureRendererErrors(main));
  await main.waitForFunction(() => !!window.codeshell?.computerUse && !!window.codeshell?.pet);
  // A fresh profile may display the repository trust dialog. Dismiss through
  // its real read-only choice so focus is not trapped above the Mimi page.
  const trust = main.getByRole("button", { name: /仅查看|View only/i });
  if (
    await trust.waitFor({ state: "visible", timeout: 5_000 }).then(
      () => true,
      () => false,
    )
  )
    await trust.click();
  receipt.guard = await fixture.assertWorker(app, { requireWorker: false });
  // A worker's stdin remains corked until this fixture verifies its bootstrap.
  // Keep doing that for replacement workers during the optional manual session.
  guardTimer = setInterval(() => {
    if (guardRunning) return;
    guardRunning = true;
    guardWork = (async () => {
      try {
        const workers = await readFile(join(isolated.home, "spawned-workers.jsonl"), "utf8").catch(
          (error) => {
            if (error.code === "ENOENT") return "";
            throw error;
          },
        );
        if (workers !== verifiedWorkers) {
          await fixture.assertWorker(app, { requireWorker: false });
          verifiedWorkers = workers;
        }
      } catch (error) {
        guardFailure = error;
        requestStop();
      } finally {
        guardRunning = false;
      }
    })();
  }, 1_000);
  receipt.display = await app.evaluate(({ BrowserWindow, screen }, right) => {
    const displays = screen.getAllDisplays();
    const selected = right
      ? displays.find(
          ({ bounds }) => bounds.x > 0 && bounds.width === 2560 && bounds.height === 1440,
        )
      : screen.getPrimaryDisplay();
    if (!selected) throw Error("The requested right-side 2560×1440 display is unavailable");
    const target = BrowserWindow.getAllWindows().find((win) => {
      const url = new URL(win.webContents.getURL());
      return url.pathname.endsWith("/renderer/index.html") && !url.searchParams.has("popout");
    });
    const area = selected.workArea;
    target.setBounds({
      x: area.x + 60,
      y: area.y + 50,
      width: Math.min(1100, area.width - 120),
      height: Math.min(900, area.height - 100),
    });
    target.setTitle("Mimi 完整应用验收 · 本地 mock 模型");
    return {
      id: selected.id,
      bounds: selected.bounds,
      workArea: area,
      scaleFactor: selected.scaleFactor,
    };
  }, flags.has("--right-display"));
  await main.evaluate(async () => {
    await window.codeshell.pet.setWidgetVisible(false);
    await window.codeshell.computerUse.setCompanion({ enabled: true, size: 240 });
  });
  let overlay;
  await bounded(
    (async () => {
      while (!overlay) {
        overlay = app
          .windows()
          .find((page) => new URL(page.url()).pathname.endsWith("/mimi-companion.html"));
        if (!overlay) await new Promise((done) => setTimeout(done, 100));
      }
    })(),
    15_000,
    "Companion window did not appear",
  );
  rendererErrors.push(captureRendererErrors(overlay));
  const body = overlay.getByRole("button", { name: "打开 Mimi 聊天，拖动可移动" });
  await body.waitFor({ state: "visible" });
  const { workArea } = receipt.display;
  const anchor = {
    x: Math.round(workArea.x + workArea.width * 0.76),
    y: Math.round(workArea.y + workArea.height * 0.45),
  };
  await overlay.evaluate((point) => {
    window.mimiCompanion.interaction("begin");
    window.mimiCompanion.move(point);
    window.mimiCompanion.interaction("end");
    window.mimiCompanion.interaction("leave");
  }, anchor);
  await overlay.waitForFunction(async (point) => {
    const state = await window.mimiCompanion.getState();
    return (
      Math.abs(state.windowOrigin.x + state.position.x - point.x) <= 1 &&
      Math.abs(state.windowOrigin.y + state.position.y - point.y) <= 1
    );
  }, anchor);
  receipt.checks.push("native host placement uses actual window origin on selected display");

  // Regression: leaving the body for its context menu suppressed pointerleave.
  // Dismissing outside must release the real host's human-interaction hold.
  await body.click({ button: "right" });
  await overlay.getByRole("menu").waitFor({ state: "visible" });
  await overlay.mouse.click(12, 12);
  await overlay.getByRole("menu").waitFor({ state: "hidden" });
  await overlay.waitForFunction(async () => !(await window.mimiCompanion.getState()).humanActive);
  await body.click({ button: "right" });
  await overlay.getByRole("menu").waitFor({ state: "visible" });
  await overlay.mouse.move(12, 12);
  await overlay.keyboard.press("Escape");
  await overlay.getByRole("menu").waitFor({ state: "hidden" });
  await overlay.waitForFunction(async () => !(await window.mimiCompanion.getState()).humanActive);
  receipt.checks.push("outside click and Escape release the production host interaction hold");

  await body.click();
  await main.locator('[data-pet-manager-chat="true"]').waitFor({ state: "visible" });
  await main.waitForFunction(() => {
    const chat = document.querySelector('[data-pet-manager-chat="true"]');
    return chat && !chat.closest('[aria-hidden="true"], [inert]');
  });
  const composer = main.locator('[data-pet-composer="true"]');
  await main.waitForFunction(() => !document.querySelector('[data-pet-composer="true"]')?.disabled);
  const firstStatus = await main.evaluate(() =>
    window.codeshell.pet.dispatch({ type: "get_global_status" }),
  );
  assert.equal(firstStatus.ok, true);
  assert.equal(firstStatus.type, "global_status");
  const inputs = [
    "COMPANION_CHAT_FIRST: hello from the local mock acceptance",
    "COMPANION_CHAT_SECOND: continue the same chat",
  ];
  for (let index = 0; index < inputs.length; index++) {
    await composer.fill(inputs[index]);
    await main.getByRole("button", { name: "发送", exact: true }).click();
    receipt.guard = await fixture.assertWorker(app);
    await main.waitForFunction(
      (expected) => {
        const text = document.querySelector('[data-pet-manager-chat="true"]')?.textContent ?? "";
        return text.split("The plain streaming smoke response completed.").length - 1 >= expected;
      },
      index + 1,
      { timeout: 30_000 },
    );
  }
  const secondStatus = await main.evaluate(() =>
    window.codeshell.pet.dispatch({ type: "get_global_status" }),
  );
  assert.equal(secondStatus.petSessionId, firstStatus.petSessionId);
  const continued = model.requests.filter(({ body }) =>
    JSON.stringify(body.messages).includes(inputs[1]),
  );
  assert.ok(continued.length > 0, "Second UI input never reached the local provider");
  assert.ok(
    continued.some(({ body }) => JSON.stringify(body.messages).includes(inputs[0])),
    "Conversation lost the first UI input",
  );
  assert.ok(
    continued.some(({ body }) =>
      body.tools?.some((tool) => tool.function?.name === "DelegateWork"),
    ),
    "Actual worker did not load the Pet capability",
  );
  receipt.petSessionId = firstStatus.petSessionId;
  receipt.providerRequests = model.requests.length;
  receipt.checks.push(
    "companion click opens real Mimi chat; two UI inputs reach the actual worker in one session",
  );
  await overlay.waitForFunction(async () => (await window.mimiCompanion.getState()).humanActive);
  const mainWindowId = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => {
      const url = new URL(candidate.webContents.getURL());
      return url.pathname.endsWith("/renderer/index.html") && !url.searchParams.has("popout");
    });
    win.hide();
    return win.id;
  });
  await overlay.waitForFunction(async () => !(await window.mimiCompanion.getState()).humanActive);
  await app.evaluate(({ BrowserWindow }, id) => {
    const win = BrowserWindow.fromId(id);
    win.show();
    win.focus();
  }, mainWindowId);
  await overlay.waitForFunction(async () => (await window.mimiCompanion.getState()).humanActive);
  receipt.checks.push("chat focus holds presentation and switching away releases it");
  receipt.passed = true;
  await put(join(isolated.home, "companion-trial-state.json"), receipt);
  console.log(JSON.stringify({ phase: "companion-chat-passed", ...receipt }));

  if (flags.has("--keep-open")) {
    console.log(
      `Owned trial ready: PID ${receipt.mainPid}; HOME ${isolated.home}; state ${join(isolated.home, "companion-trial-state.json")}. Replies use a LOCAL MOCK MODEL. Type exit and Enter, close this app, or Ctrl-C to clean up. Maximum 30 minutes.`,
    );
    await new Promise((done) => {
      stopKeepingOpen = done;
      const timer = setTimeout(done, 30 * 60_000);
      timer.unref();
      app.once("close", done);
      stdin = createInterface({ input: process.stdin });
      stdin.on("line", (line) => {
        if (line.trim() === "exit") done();
      });
    });
    if (guardFailure) throw guardFailure;
  }
} catch (error) {
  receipt.passed = false;
  receipt.error = String(error);
  receipt.mainStderr = mainStderr;
  receipt.chatAtFailure = await main
    ?.locator('[data-pet-manager-chat="true"]')
    .innerText({ timeout: 1_000 })
    .catch(() => undefined);
  process.exitCode = 1;
  console.error(error);
} finally {
  clearInterval(guardTimer);
  await guardWork;
  stdin?.close();
  process.off("SIGINT", requestStop);
  process.off("SIGTERM", requestStop);
  if (app && app.process().exitCode === null && app.process().signalCode === null) {
    await bounded(app.close(), 5_000, "Owned app close timed out").catch(() =>
      monitor?.terminate(),
    );
  }
  const settlement = await monitor?.completed;
  receipt.cleanup = settlement ?? { status: "not-launched" };
  receipt.rendererErrors = rendererErrors.flat().map((error) => error.message);
  if (guardFailure) receipt.guardError = String(guardFailure);
  if (
    guardFailure ||
    receipt.rendererErrors.length ||
    (monitor && settlement?.status !== "cleaned")
  ) {
    receipt.passed = false;
    process.exitCode = 1;
  }
  await model?.close();
  await assertOfflinePluginBootstrapHeld(isolated.codeShellHome).catch((error) => {
    receipt.passed = false;
    receipt.bootstrapError = String(error);
    process.exitCode = 1;
  });
  if (!monitor || settlement?.status === "cleaned") {
    await isolated.cleanup();
    receipt.homeRemoved = true;
  } else receipt.homeRemoved = false;
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      phase: "companion-chat-finished",
      passed: receipt.passed,
      receipt: receiptPath,
      homeRemoved: receipt.homeRemoved,
    }),
  );
}
