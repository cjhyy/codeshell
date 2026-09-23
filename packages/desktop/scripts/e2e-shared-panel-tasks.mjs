/* Real Electron main/preload/guest plus the paired Desktop HTTP facade.
 * Synthetic reviewed Node entry; no model or third-party credentials required. */
/* global document, window */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TrustedDeviceStore } from "@cjhyy/code-shell-server/mobile-remote";
import {
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
} from "./electron-harness.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isolated = await makeIsolatedElectronHome("codeshell-shared-task-e2e-");
// Native package authorization intentionally rejects symlinked install roots.
// macOS temp folders use /var -> /private/var, so canonicalize this test profile.
isolated.home = await realpath(isolated.home);
isolated.codeShellHome = join(isolated.home, ".code-shell");
isolated.userDataDir = join(isolated.home, "electron-user-data");
const project = join(isolated.home, "task-project");
const install = join(isolated.codeShellHome, "panel-apps", "task-fixture");
const installedAt = new Date().toISOString();
const source = `let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", part => input += part);
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  process.stdout.write(JSON.stringify({type:"progress", progress:{stage:"waiting", fraction:0.5}}) + "\\n");
  setTimeout(() => process.stdout.write(JSON.stringify({type:"result",result:{message:request.message}}) + "\\n"), request.delayMs);
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
  permissions: ["context.workspace", "process", "resources"],
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
      join(isolated.codeShellHome, "desktop/recents.json"),
      JSON.stringify([{ path: project, name: "Task project", lastOpenedAt: Date.now() }]),
    ),
  ]);
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
  const panel = await win.evaluate(
    async (cwd) =>
      (await window.codeshell.listPanelApps(cwd, "en")).find(
        (item) => item.appId === "task-fixture",
      ),
    project,
  );
  assert.ok(panel, "Panel was not installed");
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
    ({ guestId, id, cwd }) =>
      window.codeshell.bindPanelApp({
        guestId,
        appDescriptorId: id,
        tabId: "shared-task-test",
        bucket: "shared-task-test",
        projectPath: cwd,
        cwd,
        visible: true,
        busy: false,
        theme: "light",
        locale: "en",
      }),
    { guestId, id: panel.id, cwd: project },
  );
  const desktop = (method, params) =>
    view.evaluate(
      (view, { method, params }) =>
        view.executeJavaScript(
          `window.codeshellPanel.call(${JSON.stringify(method)}, ${JSON.stringify(params)})`,
        ),
      { method, params },
    );
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
    return json(
      await request("/api/v1/panels/runtime/prepare", "POST", {
        appId: panel.id,
        revision: panel.revision,
      }),
    );
  }
  await login();
  let phone = await openPhone();
  const phoneCall = (method, params) =>
    request(`/api/v1/panels/runtime/${phone.instanceId}/call`, "POST", { method, params }).then(
      json,
    );
  assert.equal(phone.context.capabilities.tasks.executionRevision, panel.revision);
  const startInput = {
    entry: "worker",
    input: { request: { message: "from desktop", delayMs: 30000 } },
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
  const first = await desktop("tasks.start", startInput);
  await until(
    () => waiting(first.id),
    "Desktop native process did not reach its progress checkpoint",
  );
  assert.equal((await phoneCall("tasks.get", { id: first.id })).id, first.id);
  await until(
    async () =>
      (await json(await request(`/api/v1/panels/runtime/${phone.instanceId}/events`))).events.some(
        (event) => event.event === "tasks.changed" && event.payload.id === first.id,
      ),
    "Phone did not receive Desktop progress",
  );
  await phoneCall("tasks.cancel", { id: first.id });
  assert.equal((await desktop("tasks.get", { id: first.id })).status, "cancelled");
  const secondInput = {
    ...startInput,
    input: { request: { message: "from phone", delayMs: 4000 } },
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
  assert.equal((await desktop("tasks.list", {})).filter((job) => job.id === second.id).length, 1);
  const third = await desktop("tasks.start", { ...startInput, requestKey: "remote-stop" });
  await until(() => waiting(third.id), "Third task not running");
  await win.evaluate((id) => window.codeshell.mobileRemote.revokeDevice(id), device.id);
  assert.equal((await request("/api/v1/panels")).status, 401);
  assert.equal((await desktop("tasks.get", { id: third.id })).status, "running");
  await win.evaluate(() => window.codeshell.mobileRemote.stop());
  assert.equal((await desktop("tasks.get", { id: third.id })).status, "running");
  await desktop("tasks.cancel", { id: third.id });
  console.log(
    JSON.stringify({
      actualElectron: true,
      pairedHttp: true,
      sharedRevision: true,
      sharedTaskIds: true,
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
