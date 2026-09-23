/* Real Electron main/preload/guest plus the paired Desktop HTTP facade.
 * Synthetic reviewed Node entry; no model or third-party credentials required. */
/* global document, window */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TrustedDeviceStore } from "@cjhyy/code-shell-server/mobile-remote";
import {
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
} from "./electron-harness.mjs";

const legacyProjects = process.argv.includes("--legacy-projects");
const projectPins = legacyProjects || process.argv.includes("--project-pins");
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isolated = await makeIsolatedElectronHome("codeshell-shared-task-e2e-");
// Native package authorization intentionally rejects symlinked install roots.
// macOS temp folders use /var -> /private/var, so canonicalize this test profile.
isolated.home = await realpath(isolated.home);
isolated.codeShellHome = join(isolated.home, ".code-shell");
isolated.userDataDir = join(isolated.home, "electron-user-data");
const project = join(isolated.home, "task-project");
const automationSessionId = "shared-automation-session";
const install = join(isolated.codeShellHome, "panel-apps", "task-fixture");
const installedAt = new Date().toISOString();
const source = `import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", part => input += part);
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  const directory = process.argv[process.argv.indexOf("--output-dir") + 1];
  const cookieIndex = Math.max(process.argv.indexOf("--cookies-file"), process.argv.indexOf("--cookies"));
  const cookieRead = cookieIndex >= 0 && readFileSync(process.argv[cookieIndex+1],"utf8").includes("shared-cookie-fixture");
  if (cookieIndex >= 0 && !cookieRead) process.exit(3);
  if (cookieIndex < 0) writeFileSync(join(directory, request.message + ".txt"), request.message, { flag: "wx" });
  process.stdout.write(JSON.stringify({type:"progress", progress:{stage:"waiting", fraction:0.5}}) + "\\n");
  setTimeout(() => process.stdout.write(JSON.stringify({type:"result",result:{message:request.message,...(cookieRead?{cookieRead:true}:{})}}) + "\\n"), request.delayMs);
});
`;
const manifest = {
  schemaVersion: 2,
  id: "task-fixture",
  version: "1.0.0",
  title: { default: "Task fixture" },
  entry: "app/index.html",
  icon: "panel",
  singleton: true,
  placement: "right-dock",
  permissions: [
    "context.workspace",
    "context.session",
    "automations.manage",
    "process",
    "resources",
    "credentials.cookies",
  ],
  nativeEntries: {
    worker: {
      entry: "app/tools/worker.mjs",
      sha256: createHash("sha256").update(source).digest("hex"),
    },
  },
};
let electron;
async function until(read, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(message);
}
try {
  await Promise.all([
    mkdir(join(install, ".codeshell-panel"), { recursive: true }),
    mkdir(join(install, "app/tools"), { recursive: true }),
    mkdir(join(project, ".code-shell"), { recursive: true }),
    mkdir(join(isolated.codeShellHome, "desktop"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(install, ".codeshell-panel/panel.json"), JSON.stringify(manifest)),
    writeFile(
      join(install, "app/index.html"),
      "<!doctype html><html><body>Shared task fixture</body></html>",
    ),
    writeFile(join(install, "app/tools/worker.mjs"), source),
    writeFile(
      join(install, ".cs-panel-app-meta.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: manifest.id,
        version: manifest.version,
        source: install,
        installedAt,
      }),
    ),
    writeFile(
      join(isolated.codeShellHome, "panel-apps/installed.json"),
      JSON.stringify({
        version: 1,
        apps: [
          {
            id: manifest.id,
            version: manifest.version,
            source: install,
            installedAt,
            lastUpdated: installedAt,
          },
        ],
      }),
    ),
    writeFile(
      join(project, ".code-shell/settings.json"),
      JSON.stringify({ panelAppBindings: [manifest.id] }),
    ),
    writeFile(
      join(project, ".code-shell/credentials.json"),
      JSON.stringify({
        version: 1,
        credentials: [
          {
            id: "shared-cookie",
            type: "cookie",
            label: "Shared fixture account",
            meta: { domain: "example.com" },
            secret: JSON.stringify([
              { domain: ".example.com", name: "session", value: "shared-cookie-fixture" },
            ]),
          },
        ],
      }),
      { mode: 0o600 },
    ),
    writeFile(
      join(isolated.codeShellHome, "desktop/recents.json"),
      JSON.stringify([{ path: project, name: "Task project", lastOpenedAt: Date.now() }]),
    ),
  ]);
  if (projectPins) {
    // Retain the project's v1 package, then install a distinguishable v2 in the
    // global catalog. Both the actual Electron guest and paired HTTP must keep v1.
    const previousHome = process.env.HOME;
    process.env.HOME = isolated.home;
    try {
      const {
        listInstalledPanelApps,
        retainInstalledPanelApp,
        previewLocalPanelApp,
        installReviewedLocalPanelApp,
      } = await import("@cjhyy/code-shell-core");
      const current = (await listInstalledPanelApps()).find((item) => item.id === manifest.id);
      assert.ok(current?.packageDigest);
      if (!legacyProjects) {
        await retainInstalledPanelApp(manifest.id, current.packageDigest);
        await writeFile(
          join(project, ".code-shell/settings.json"),
          JSON.stringify({
            panelAppBindings: [manifest.id],
            panelAppPins: {
              [manifest.id]: { version: current.version, packageDigest: current.packageDigest },
            },
          }),
        );
      }
      const newer = join(isolated.home, "catalog-v2");
      await mkdir(join(newer, ".codeshell-panel"), { recursive: true });
      await mkdir(join(newer, "app/tools"), { recursive: true });
      const nextSource = source.replace(
        "const request = JSON.parse(input);",
        'const request = JSON.parse(input); request.message += "-catalog-v2";',
      );
      await writeFile(join(newer, "app/tools/worker.mjs"), nextSource);
      await writeFile(
        join(newer, "app/index.html"),
        "<!doctype html><body>Catalog version 2</body>",
      );
      await writeFile(
        join(newer, ".codeshell-panel/panel.json"),
        JSON.stringify({
          ...manifest,
          version: "2.0.0",
          nativeEntries: {
            worker: {
              entry: manifest.nativeEntries.worker.entry,
              sha256: createHash("sha256").update(nextSource).digest("hex"),
            },
          },
        }),
      );
      const input = { kind: "dir", path: newer };
      const review = await previewLocalPanelApp(input);
      await installReviewedLocalPanelApp(input, review.reviewToken, new Date().toISOString(), {
        overwrite: true,
      });
      assert.equal((await listInstalledPanelApps())[0].version, "2.0.0");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  }
  const secret = randomBytes(32).toString("hex");
  const devices = new TrustedDeviceStore(join(isolated.userDataDir, "mobile-remote/devices.json"));
  const device = devices.addDevice({ name: "Shared task test browser", secretHash: secret });
  electron = await launchCodeShellElectron({
    appDir,
    home: isolated.home,
    userDataDir: isolated.userDataDir,
  });
  const win = await findCodeShellWindow(electron);
  const viewOnly = win.getByRole("button", { name: /仅查看|View only/i });
  if (
    await viewOnly.waitFor({ state: "visible", timeout: 3000 }).then(
      () => true,
      () => false,
    )
  )
    await viewOnly.click();
  await win.evaluate((cwd) => window.codeshell.setTrust(cwd, "trusted"), project);
  const registeredProject = await win.evaluate(async (cwd) => {
    const projects = await window.codeshell.projectRegistry.list();
    return projects.find((entry) => entry.roots.some((root) => root.path === cwd));
  }, project);
  assert.ok(registeredProject, "Automation fixture project must be registered");
  // Synthetic durable Session binding; no model execution is requested here.
  const automationSessionDir = join(isolated.codeShellHome, "sessions", automationSessionId);
  await mkdir(automationSessionDir, { recursive: true });
  await writeFile(
    join(automationSessionDir, "state.json"),
    JSON.stringify({
      sessionId: automationSessionId,
      cwd: project,
      project: { projectId: registeredProject.id, mainRootId: registeredProject.primaryRootId },
    }),
  );
  const panel = await win.evaluate(
    async (cwd) =>
      (await window.codeshell.listPanelApps(cwd, "en")).find(
        (item) => item.appId === "task-fixture",
      ),
    project,
  );
  assert.ok(panel, "Panel was not installed");
  assert.equal(panel.version, "1.0.0");
  if (projectPins) assert.equal(panel.packagePinned, true);
  if (legacyProjects) {
    const migrated = JSON.parse(await readFile(join(project, ".code-shell/settings.json"), "utf8"));
    assert.equal(migrated.panelAppPins[manifest.id].version, "1.0.0");
    assert.equal(migrated.panelAppPins[manifest.id].packageDigest, panel.packageDigest);
  }
  // The production native binding API materializes legacy pins and shares the
  // exact conditional revision with paired Web. No raw project settings write.
  const bindingBefore = await win.evaluate(
    async (cwd) =>
      (await window.codeshell.getPanelAppBindings(cwd)).find(
        (item) => item.appId === "task-fixture",
      ),
    project,
  );
  const bindingAfter = await win.evaluate(
    async ({ cwd, state }) =>
      (
        await window.codeshell.setPanelAppProjectBinding(cwd, state.appId, true, state.revision)
      ).find((item) => item.appId === state.appId),
    { cwd: project, state: bindingBefore },
  );
  assert.equal(bindingAfter.version, "1.0.0");
  assert.ok(bindingAfter.packageDigest);
  const boundSettings = JSON.parse(
    await readFile(join(project, ".code-shell/settings.json"), "utf8"),
  );
  assert.equal(boundSettings.panelAppPins[manifest.id].packageDigest, bindingAfter.packageDigest);
  const currentPanel = await win.evaluate(
    async (cwd) =>
      (await window.codeshell.listPanelApps(cwd, "en")).find(
        (item) => item.appId === "task-fixture",
      ),
    project,
  );
  Object.assign(panel, currentPanel);
  const prepared = await win.evaluate(({ id, cwd }) => window.codeshell.preparePanelApp(id, cwd), {
    id: panel.id,
    cwd: project,
  });
  await win.evaluate(({ src, partition }) => {
    const view = document.createElement("webview");
    view.id = "shared-task-test";
    view.setAttribute("partition", partition);
    view.setAttribute("src", src);
    view.style.width = "640px";
    view.style.height = "480px";
    document.body.appendChild(view);
  }, prepared);
  const view = win.locator("#shared-task-test");
  await win.waitForFunction(() => {
    const view = document.getElementById("shared-task-test");
    return typeof view?.getWebContentsId === "function" && view.getWebContentsId() > 0;
  });
  const guestId = await view.evaluate((view) => view.getWebContentsId());
  await win.evaluate(
    ({ guestId, id, cwd, sessionId }) =>
      window.codeshell.bindPanelApp({
        guestId,
        appDescriptorId: id,
        tabId: "shared-task-test",
        bucket: "shared-task-test",
        projectPath: cwd,
        cwd,
        sessionId,
        visible: true,
        busy: false,
        theme: "light",
        locale: "en",
      }),
    { guestId, id: panel.id, cwd: project, sessionId: automationSessionId },
  );
  let nextDesktopCall = 0;
  const desktop = async (method, params) => {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, nextDesktopCall - Date.now())));
    nextDesktopCall = Date.now() + 450;
    return view.evaluate(
      (view, { method, params }) =>
        view.executeJavaScript(
          `window.codeshellPanel.call(${JSON.stringify(method)}, ${JSON.stringify(params)})`,
        ),
      { method, params },
    );
  };
  await until(
    () =>
      view
        .evaluate((view) => view.executeJavaScript('typeof window.codeshellPanel === "object"'))
        .catch(() => false),
    "Panel bridge not ready",
  );
  const remote = await win.evaluate(() => window.codeshell.mobileRemote.start({ mode: "lan" }));
  assert.ok(remote.url, "Remote server did not start");
  const base = new URL(remote.url).origin;
  let cookie;
  const request = (path, method = "GET", body) =>
    fetch(base + path, {
      method,
      headers: {
        Origin: base,
        "X-CodeShell-Workspace": encodeURIComponent(project),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = async (response) => {
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  async function login() {
    const response = await request("/api/v1/desktop/session", "POST", {
      deviceId: device.id,
      secretHash: secret,
    });
    assert.equal(response.status, 200, await response.clone().text());
    cookie = response.headers.get("set-cookie").split(";", 1)[0];
  }
  async function openPhone() {
    const catalog = await json(await request("/api/v1/panels"));
    const panel = catalog.panels.find((item) => item.id === "task-fixture");
    assert.equal(panel.version, "1.0.0");
    return json(
      await request("/api/v1/panels/runtime/prepare", "POST", {
        appId: panel.id,
        revision: panel.revision,
        sessionId: automationSessionId,
      }),
    );
  }
  await login();
  let phone = await openPhone();
  const phoneCall = (method, params) =>
    request(`/api/v1/panels/runtime/${phone.instanceId}/call`, "POST", { method, params }).then(
      json,
    );
  assert.ok(phone.context.availableMethods.includes("automations.createUnique"));
  const automationInput = {
    key: "shared-reminder",
    name: "Shared recurring reminder",
    schedule: "1h",
    prompt: "Fixture only; never run",
    timezone: "UTC",
  };
  const nativeAutomation = await desktop("automations.createUnique", automationInput);
  const phoneReplay = await phoneCall("automations.createUnique", automationInput);
  assert.equal(phoneReplay.id, nativeAutomation.id);
  assert.equal((await phoneCall("automations.list", {})).automations.length, 1);
  await phoneCall("automations.pause", { id: nativeAutomation.id });
  assert.equal((await desktop("automations.list", {})).automations[0].enabled, false);
  await phoneCall("automations.update", { id: nativeAutomation.id, prompt: "Edited on phone" });
  assert.equal((await desktop("automations.list", {})).automations[0].prompt, "Edited on phone");
  const phoneCreated = await phoneCall("automations.createUnique", {
    ...automationInput,
    key: "phone-reminder",
  });
  assert.equal((await desktop("automations.list", {})).automations.length, 2);
  await desktop("automations.delete", { id: phoneCreated.id });
  await phoneCall("automations.delete", { id: nativeAutomation.id });
  assert.equal((await desktop("automations.list", {})).automations.length, 0);
  assert.equal(phone.context.capabilities.tasks.executionRevision, panel.revision);
  const projectDirectory = await desktop("filesystem.getKnownDirectory", { name: "project" });
  assert.equal(
    (await phoneCall("filesystem.restoreDirectory", { bookmark: projectDirectory.bookmark })).path,
    project,
  );
  assert.equal(await phoneCall("tasks.find", { requestKey: "desktop-and-phone" }), null);
  assert.equal(phone.context.capabilities.tasks.cookieCredentials, true);
  const accountQuery = { url: "https://example.com/watch" };
  const accounts = await desktop("credentials.cookies.listForTask", accountQuery);
  assert.deepEqual(await phoneCall("credentials.cookies.listForTask", accountQuery), accounts);
  assert.equal(accounts.accounts[0].label, "Shared fixture account");
  const cookieInput = {
    entry: "worker",
    recovery: "retry",
    requestKey: "cookie-desktop",
    input: {
      request: { message: "cookie desktop", delayMs: 30000 },
      cookieArgument: {
        argumentName: "--cookies-file",
        credentialId: accounts.accounts[0].id,
        revision: accounts.accounts[0].revision,
        url: accountQuery.url,
      },
    },
  };
  // Only native dialog responses are synthetic; real IPC, vault, file leases and tasks run.
  await electron.evaluate(({ dialog }) => {
    globalThis.__cookieDecision = 1;
    globalThis.__cookiePrompts = [];
    dialog.showMessageBox = async (_owner, options) => {
      globalThis.__cookiePrompts.push(options);
      return { response: globalThis.__cookieDecision, checkboxChecked: false };
    };
  });
  await assert.rejects(desktop("tasks.start", cookieInput), /cancelled/i);
  assert.equal(await desktop("tasks.find", { requestKey: cookieInput.requestKey }), null);
  await electron.evaluate(() => {
    globalThis.__cookieDecision = 0;
  });
  const cookieTask = await desktop("tasks.start", cookieInput);
  await until(
    async () => (await phoneCall("tasks.get", { id: cookieTask.id })).progress?.stage === "waiting",
    "Cookie program not running",
  );
  await phoneCall("tasks.cancel", { id: cookieTask.id });
  await electron.evaluate(() => {
    globalThis.__cookieDecision = 1;
  });
  await assert.rejects(desktop("tasks.retry", { id: cookieTask.id }), /cancelled/i);
  assert.equal((await desktop("tasks.get", { id: cookieTask.id })).status, "cancelled");
  await electron.evaluate(() => {
    globalThis.__cookieDecision = 0;
  });
  assert.equal((await desktop("tasks.retry", { id: cookieTask.id })).id, cookieTask.id);
  await until(
    async () => (await phoneCall("tasks.get", { id: cookieTask.id })).progress?.stage === "waiting",
    "Cookie retry not running",
  );
  await phoneCall("tasks.cancel", { id: cookieTask.id });
  const prompts = await electron.evaluate(() => globalThis.__cookiePrompts);
  assert.equal(prompts.length, 4);
  assert.ok(
    prompts.every(
      (prompt) =>
        prompt.message.includes("Shared fixture account") && prompt.detail.includes("example.com"),
    ),
  );
  const phoneCookie = phoneCall("tasks.start", {
    ...cookieInput,
    requestKey: "cookie-phone",
    input: { ...cookieInput.input, request: { message: "cookie phone", delayMs: 100 } },
  });
  const cookieConsent = await until(
    async () =>
      (await json(await request(`/api/v1/panels/runtime/${phone.instanceId}/events`))).events.find(
        (event) => event.event === "host.confirm",
      ),
    "Phone Cookie confirmation missing",
  );
  assert.match(JSON.stringify(cookieConsent.payload), /Shared fixture account/);
  assert.doesNotMatch(JSON.stringify(cookieConsent.payload), /shared-cookie-fixture/);
  await json(
    await request(`/api/v1/panels/runtime/${phone.instanceId}/confirm`, "POST", {
      requestId: cookieConsent.payload.requestId,
      allowed: true,
    }),
  );
  const phoneCookieTask = await phoneCookie;
  await until(
    async () => (await phoneCall("tasks.get", { id: phoneCookieTask.id })).status === "succeeded",
    "Phone Cookie task failed",
  );
  const cookieResult = await desktop("tasks.get", { id: phoneCookieTask.id });
  assert.equal(cookieResult.result.cookieRead, true);
  assert.ok(!JSON.stringify(cookieResult).includes("shared-cookie-fixture"));
  assert.deepEqual(
    (await readdir(join(isolated.userDataDir, "panel-task-cookies"))).filter((name) =>
      name.startsWith("cookies-"),
    ),
    [],
  );
  await json(
    await request(`/api/v1/panels/runtime/${phone.instanceId}/events?after=${cookieConsent.id}`),
  );
  // Paired Web uses the Desktop vault for short metadata processes too. It receives
  // only an opaque grant; account consent and executable consent remain distinct.
  assert.equal(phone.context.capabilities.process.cookieCredentials, true);
  const executable = await phoneCall("process.find", { name: "node" });
  const entry = await phoneCall("process.resolveEntry", {
    name: "worker",
    executableHandle: executable.handle,
  });
  const directory = await phoneCall("filesystem.getKnownDirectory", { name: "project" });
  async function phoneConsent(pending) {
    const event = await until(
      async () =>
        (
          await json(await request(`/api/v1/panels/runtime/${phone.instanceId}/events`))
        ).events.find((item) => item.event === "host.confirm"),
      "Temporary-process confirmation missing",
    );
    assert.doesNotMatch(JSON.stringify(event), /shared-cookie-fixture/);
    await json(
      await request(`/api/v1/panels/runtime/${phone.instanceId}/confirm`, "POST", {
        requestId: event.payload.requestId,
        allowed: true,
      }),
    );
    const result = await pending;
    await json(
      await request(`/api/v1/panels/runtime/${phone.instanceId}/events?after=${event.id}`),
    );
    return result;
  }
  const authorization = await phoneConsent(
    phoneCall("credentials.cookies.authorizeProcess", {
      executableHandle: executable.handle,
      credentialId: accounts.accounts[0].id,
      revision: accounts.accounts[0].revision,
      url: accountQuery.url,
    }),
  );
  assert.deepEqual(Object.keys(authorization).sort(), [
    "authorized",
    "count",
    "fileArgumentHandle",
  ]);
  assert.equal(authorization.authorized, true);
  const metadata = await phoneConsent(
    phoneCall("process.spawn", {
      executableHandle: executable.handle,
      entryHandle: entry.handle,
      directoryHandle: directory.handle,
      fileArgumentHandles: [authorization.fileArgumentHandle],
      args: [],
      stdin: "pipe",
    }),
  );
  await phoneCall("process.write", {
    processId: metadata.processId,
    text: JSON.stringify({ message: "phone metadata", delayMs: 100 }),
  });
  await phoneCall("process.end", { processId: metadata.processId });
  const receipt = await until(async () => {
    const value = await phoneCall("process.get", { processId: metadata.processId });
    return value?.status === "exited" ? value : false;
  }, "Paired metadata process did not finish");
  assert.equal(receipt.code, 0);
  assert.match(JSON.stringify(receipt), /cookieRead/);
  assert.doesNotMatch(JSON.stringify(receipt), /shared-cookie-fixture/);
  await json(await request(`/api/v1/panels/runtime/${phone.instanceId}`, "DELETE"));
  await until(
    async () =>
      !(await readdir(join(isolated.userDataDir, "panel-task-cookies"))).some((name) =>
        name.startsWith("cookies-"),
      ),
    "Paired temporary account file survived page closure",
  );
  phone = await openPhone();
  const selectedFolder = join(isolated.home, "explicit-output");
  await mkdir(selectedFolder);
  // Only the OS picker result is synthetic. The real guest bridge, trust checks,
  // bookmark persistence and paired HTTP restoration remain in the path.
  await electron.evaluate(({ dialog }, folder) => {
    const original = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => {
      dialog.showOpenDialog = original;
      return { canceled: false, filePaths: [folder] };
    };
  }, selectedFolder);
  const selected = await desktop("filesystem.pickDirectory", {});
  const restored = await phoneCall("filesystem.restoreDirectory", { bookmark: selected.bookmark });
  assert.equal(restored.path, selectedFolder);
  assert.equal(restored.bookmark, selected.bookmark);
  const fileUrl = await phoneCall("filesystem.openDirectory", { handle: restored.handle });
  assert.equal((await request(fileUrl.url)).status, 200);
  const choosing = phoneCall("filesystem.pickDirectory", {});
  const selectionConsent = await until(
    async () =>
      (await json(await request(`/api/v1/panels/runtime/${phone.instanceId}/events`))).events.find(
        (event) => event.event === "host.confirm",
      ),
    "Directory consent missing",
  );
  await json(
    await request(`/api/v1/panels/runtime/${phone.instanceId}/confirm`, "POST", {
      requestId: selectionConsent.payload.requestId,
      allowed: true,
    }),
  );
  const phoneFolder = await choosing;
  assert.equal(
    (await desktop("filesystem.restoreDirectory", { bookmark: phoneFolder.bookmark })).path,
    phoneFolder.path,
  );
  // Acknowledge the consumed picker event before waiting for native task consent.
  await json(
    await request(`/api/v1/panels/runtime/${phone.instanceId}/events?after=${selectionConsent.id}`),
  );
  const startInput = {
    entry: "worker",
    input: {
      request: { message: "from desktop", delayMs: 30000 },
      directoryArguments: [
        { argumentName: "--output-dir", directory: "bookmark", bookmark: selected.bookmark },
      ],
    },
    recovery: "retry",
    requestKey: "desktop-and-phone",
  };
  const waiting = async (id) => {
    const job = await desktop("tasks.get", { id });
    assert.ok(
      !["failed", "cancelled", "interrupted"].includes(job.status),
      JSON.stringify(job.error),
    );
    return job.progress?.stage === "waiting";
  };
  assert.deepEqual(
    await desktop("tasks.queue.set", {
      expectedRevision: 0,
      paused: true,
      maxConcurrent: 1,
    }),
    { saved: true, queue: { revision: 1, paused: true, maxConcurrent: 1 } },
  );
  assert.deepEqual(await phoneCall("tasks.queue.get", {}), {
    revision: 1,
    paused: true,
    maxConcurrent: 1,
  });
  let packageReview;
  const updateSource = { kind: "dir", path: join(isolated.home, "catalog-v2") };
  if (projectPins) {
    packageReview = await win.evaluate(
      ({ source, cwd }) => window.codeshell.previewLocalPanelApp(source, cwd),
      { source: updateSource, cwd: project },
    );
    assert.equal(packageReview.ok, true, JSON.stringify(packageReview));
    assert.equal(packageReview.installedVersion, "1.0.0");
    assert.equal(packageReview.preview.version, "2.0.0");
  }
  const assertPackageBusy = async () => {
    const catalog = await json(await request("/api/v1/panels"));
    const state = catalog.panels.find((item) => item.id === manifest.id);
    const response = await request(`/api/v1/panels/${manifest.id}/binding`, "PATCH", {
      bound: true,
      expectedRevision: state.revision,
    });
    assert.equal(response.status, 409, await response.clone().text());
    if (packageReview) {
      const result = await win.evaluate((input) => window.codeshell.installLocalPanelApp(input), {
        cwd: project,
        source: updateSource,
        reviewToken: packageReview.preview.reviewToken,
        overwrite: true,
      });
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.match(result.error, /任务|运行|提交/);
      const selected = await win.evaluate(
        async (cwd) => (await window.codeshell.getPanelAppBindings(cwd))[0],
        project,
      );
      assert.equal(selected.version, "1.0.0");
    }
  };
  const first = await desktop("tasks.start", startInput);
  assert.equal(first.package.version, "1.0.0");
  assert.match(first.package.packageDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual((await phoneCall("tasks.get", { id: first.id })).package, first.package);
  assert.equal((await phoneCall("tasks.get", { id: first.id })).status, "queued");
  await assertPackageBusy();
  const resuming = phoneCall("tasks.queue.set", {
    expectedRevision: 1,
    paused: false,
    maxConcurrent: 1,
  });
  const queueConsent = await until(
    async () =>
      (await json(await request(`/api/v1/panels/runtime/${phone.instanceId}/events`))).events.find(
        (event) => event.event === "host.confirm",
      ),
    "Queue resume consent missing",
  );
  await json(
    await request(`/api/v1/panels/runtime/${phone.instanceId}/confirm`, "POST", {
      requestId: queueConsent.payload.requestId,
      allowed: true,
    }),
  );
  assert.deepEqual(await resuming, {
    saved: true,
    queue: { revision: 2, paused: false, maxConcurrent: 1 },
  });
  await json(
    await request(`/api/v1/panels/runtime/${phone.instanceId}/events?after=${queueConsent.id}`),
  );
  assert.deepEqual(await desktop("tasks.queue.get", {}), {
    revision: 2,
    paused: false,
    maxConcurrent: 1,
  });
  await until(
    () => waiting(first.id),
    "Desktop native process did not reach its progress checkpoint",
  );
  assert.equal((await phoneCall("tasks.get", { id: first.id })).id, first.id);
  assert.equal((await phoneCall("tasks.find", { requestKey: "desktop-and-phone" })).id, first.id);
  await until(
    async () =>
      (await json(await request(`/api/v1/panels/runtime/${phone.instanceId}/events`))).events.some(
        (event) => event.event === "tasks.changed" && event.payload.id === first.id,
      ),
    "Phone did not receive Desktop progress",
  );
  await assertPackageBusy();
  await phoneCall("tasks.cancel", { id: first.id });
  assert.equal((await desktop("tasks.get", { id: first.id })).status, "cancelled");
  const secondInput = {
    ...startInput,
    input: { ...startInput.input, request: { message: "from phone", delayMs: 4000 } },
    requestKey: "phone-and-desktop",
  };
  const pending = phoneCall("tasks.start", secondInput);
  const confirmation = await until(
    async () =>
      (await json(await request(`/api/v1/panels/runtime/${phone.instanceId}/events`))).events.find(
        (event) => event.event === "host.confirm",
      ),
    "Remote tool did not require confirmation",
  );
  await assertPackageBusy();
  await json(
    await request(`/api/v1/panels/runtime/${phone.instanceId}/confirm`, "POST", {
      requestId: confirmation.payload.requestId,
      allowed: true,
    }),
  );
  const second = await pending;
  assert.equal((await desktop("tasks.start", secondInput)).id, second.id);
  await until(() => waiting(second.id), "Phone native process did not start");
  await json(await request("/api/v1/auth/logout", "POST", {}));
  assert.equal((await desktop("tasks.get", { id: second.id })).status, "running");
  assert.equal((await request("/api/v1/panels")).status, 401);
  await login();
  phone = await openPhone();
  const completed = await until(async () => {
    const job = await phoneCall("tasks.get", { id: second.id });
    return job.status === "succeeded" ? job : false;
  }, "Task did not finish after phone logout");
  assert.deepEqual(completed.result, { message: "from phone" });
  assert.equal(await readFile(join(selectedFolder, "from desktop.txt"), "utf8"), "from desktop");
  assert.equal(await readFile(join(selectedFolder, "from phone.txt"), "utf8"), "from phone");
  assert.ok(!JSON.stringify(completed).includes(selectedFolder));
  assert.equal((await desktop("tasks.list", {})).filter((job) => job.id === second.id).length, 1);
  if (projectPins) {
    await win.evaluate(() => {
      window.__panelPackageChanges = 0;
      window.codeshell.onPanelAppsChanged(() => window.__panelPackageChanges++);
    });
    const catalog = await json(await request("/api/v1/panels"));
    const selected = catalog.panels.find((item) => item.id === manifest.id);
    await json(
      await request(`/api/v1/panels/${manifest.id}/binding`, "PATCH", {
        bound: true,
        expectedRevision: selected.revision,
      }),
    );
    await until(
      () => win.evaluate(() => window.__panelPackageChanges > 0),
      "Phone binding did not notify the native Panel registry",
    );
    phone = await openPhone();
    assert.equal((await phoneCall("tasks.get", { id: second.id })).id, second.id);
  }
  const third = await desktop("tasks.start", {
    ...startInput,
    input: { ...startInput.input, request: { message: "remote stop", delayMs: 30000 } },
    requestKey: "remote-stop",
  });
  await until(() => waiting(third.id), "Third task not running");
  await win.evaluate((id) => window.codeshell.mobileRemote.revokeDevice(id), device.id);
  assert.equal((await request("/api/v1/panels")).status, 401);
  assert.equal((await desktop("tasks.get", { id: third.id })).status, "running");
  await win.evaluate(() => window.codeshell.mobileRemote.stop());
  assert.equal((await desktop("tasks.get", { id: third.id })).status, "running");
  await desktop("tasks.cancel", { id: third.id });
  if (packageReview) {
    // The same unconsumed review can commit once actual work has stopped.
    const result = await win.evaluate((input) => window.codeshell.installLocalPanelApp(input), {
      cwd: project,
      source: updateSource,
      reviewToken: packageReview.preview.reviewToken,
      overwrite: true,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const selected = await win.evaluate(
      async (cwd) => (await window.codeshell.getPanelAppBindings(cwd))[0],
      project,
    );
    assert.equal(selected.version, "2.0.0");
    const history = await win.evaluate(
      ({ cwd, app }) => window.codeshell.getPanelAppPackageHistory(cwd, app.appId, app.revision),
      { cwd: project, app: selected },
    );
    const retained = history.versions.find((version) => version.version === "1.0.0");
    assert.ok(retained);
    const restoreReview = await win.evaluate(
      ({ cwd, app, digest }) =>
        window.codeshell.previewPanelAppRestore(cwd, app.appId, digest, app.revision),
      { cwd: project, app: selected, digest: retained.packageDigest },
    );
    await win.evaluate(({ cwd, token }) => window.codeshell.restorePanelAppPackage(cwd, token), {
      cwd: project,
      token: restoreReview.reviewToken,
    });
    const restored = await win.evaluate(
      async (cwd) => (await window.codeshell.getPanelAppBindings(cwd))[0],
      project,
    );
    assert.equal(restored.version, "1.0.0");
    assert.equal(restored.packageDigest, first.package.packageDigest);
    const selectedPath = join(
      isolated.codeShellHome,
      "panel-apps",
      ".versions",
      manifest.id,
      restored.packageDigest,
    );
    await writeFile(join(selectedPath, "app/index.html"), "damaged package fixture");
    const issue = await win.evaluate(
      async (cwd) => (await window.codeshell.getPanelAppBindings(cwd))[0],
      project,
    );
    assert.equal(issue.unavailable, true);
    assert.equal(issue.version, "1.0.0");
    const executable = await win.evaluate(
      (cwd) => window.codeshell.listPanelAppExtensions(cwd, "zh-CN"),
      project,
    );
    assert.ok(!executable.some((app) => app.appId === manifest.id));
    const available = await win.evaluate(
      ({ cwd, app }) => window.codeshell.getPanelAppPackageHistory(cwd, app.appId, app.revision),
      { cwd: project, app: issue },
    );
    assert.equal(available.current.unavailable, true);
    const target = available.versions.find((version) => version.version === "2.0.0");
    assert.ok(target);
    const repair = await win.evaluate(
      ({ cwd, app, digest }) =>
        window.codeshell.previewPanelAppRestore(cwd, app.appId, digest, app.revision),
      { cwd: project, app: issue, digest: target.packageDigest },
    );
    assert.deepEqual(repair.addedPermissions, repair.permissions);
    await win.evaluate(({ cwd, token }) => window.codeshell.restorePanelAppPackage(cwd, token), {
      cwd: project,
      token: repair.reviewToken,
    });
    const repaired = await win.evaluate(
      async (cwd) => (await window.codeshell.getPanelAppBindings(cwd))[0],
      project,
    );
    assert.equal(repaired.version, "2.0.0");
    assert.ok(!repaired.unavailable);
    assert.ok(
      (
        await win.evaluate((cwd) => window.codeshell.listPanelAppExtensions(cwd, "zh-CN"), project)
      ).some((app) => app.appId === manifest.id),
    );
  }
  const staleBinding = await win.evaluate(
    async (cwd) => (await window.codeshell.getPanelAppBindings(cwd))[0],
    project,
  );
  await win.evaluate(
    ({ cwd, state }) =>
      window.codeshell.setPanelAppProjectBinding(cwd, state.appId, false, state.revision),
    { cwd: project, state: staleBinding },
  );
  const conflict = await win.evaluate(
    async ({ cwd, state }) => {
      try {
        await window.codeshell.setPanelAppProjectBinding(cwd, state.appId, true, state.revision);
        return false;
      } catch (error) {
        return String(error).includes("配置已改变");
      }
    },
    { cwd: project, state: staleBinding },
  );
  assert.equal(conflict, true);

  console.log(
    JSON.stringify({
      actualElectron: true,
      sharedAutomationScheduler: true,
      automationSessionAuthority: true,
      nativeConditionalProjectBinding: true,
      packageMutationBlocksQueuedRunningAndPreparing: true,
      projectUpdateAfterActualTaskExit: projectPins,
      nativeReviewedPackageRestore: projectPins,
      nativeDamagedPackageRepair: projectPins,
      projectPinnedAgainstNewerCatalog: projectPins,
      legacyProjectAutomaticallyPinned: legacyProjects,
      sharedDirectoryBookmarks: true,
      backgroundDirectoryDelivery: true,
      sharedQueueControl: true,
      pairedHttp: true,
      sharedRevision: true,
      sharedTaskIds: true,
      sharedCookieVersions: true,
      desktopCookieStartRetryConsent: true,
      phoneCookieConsent: true,
      phoneTemporaryCookieProcess: true,
      privateCookieCleanup: true,
      phoneCancellation: true,
      nativeProgress: true,
      deduplicated: true,
      logoutKeepsProjectTask: true,
      remoteStopKeepsProjectTask: true,
      deviceRevocationKeepsProjectTask: true,
      resultRecovered: true,
    }),
  );
} finally {
  await electron?.close();
  await isolated.cleanup();
}
