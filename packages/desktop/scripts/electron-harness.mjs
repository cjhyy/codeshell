/* global document, window */
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureElectronKeychainContext } from "./electron-keychain-preflight.mjs";
import { watchElectronTestProcess } from "./electron-test-watchdog.mjs";

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function makeIsolatedElectronHome(prefix = "codeshell-electron-e2e-") {
  const home = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  return {
    home,
    codeShellHome: join(home, ".code-shell"),
    userDataDir: join(home, "electron-user-data"),
    cleanup: () => rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
  };
}

export async function launchCodeShellElectron(
  {
    appDir,
    home,
    userDataDir,
    env = {},
    mainEntry,
    mainBootstrap,
    timeout = 30_000,
    runtimeTimeoutMs = 180_000,
  },
  {
    launch = async (options) => (await import("playwright"))._electron.launch(options),
    preflight = ensureElectronKeychainContext,
    watch = watchElectronTestProcess,
  } = {},
) {
  if (
    !Number.isSafeInteger(runtimeTimeoutMs) ||
    runtimeTimeoutMs <= 0 ||
    runtimeTimeoutMs > 2_147_483_647
  )
    throw new Error("Electron test runtimeTimeoutMs must be a positive safe integer");
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647)
    throw new Error("Electron test launch timeout must be a positive safe integer");
  const environment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CODE_SHELL_HOME: join(home, ".code-shell"),
    CODE_SHELL_NO_DEVTOOLS: "1",
    CODE_SHELL_DISABLE_UPDATE_CHECK: "1",
    DISABLE_AUTOUPDATER: "1",
    ...env,
  };
  // Metadata checks happen before even loading Playwright. A missing default
  // must fail here instead of entering macOS's create/reset-Keychain dialog.
  preflight({
    home,
    environment: {
      ...environment,
      // Confined fixtures deliberately scrub this parent-only metadata path
      // from the Electron environment. Keep it available to verify their
      // already-bound acceptance HOME without exposing it to the child.
      CODESHELL_MACOS_DEFAULT_KEYCHAIN_REFERENCE:
        environment.CODESHELL_MACOS_DEFAULT_KEYCHAIN_REFERENCE ??
        process.env.CODESHELL_MACOS_DEFAULT_KEYCHAIN_REFERENCE,
    },
  });
  // Playwright's Electron loader appends password-store=basic and
  // use-mock-keychain. Undo those test defaults after its loader, before
  // Electron initializes OS cryptography; a command-line argument alone loses
  // to that loader. Every caller already owns a temporary home.
  const keyringBootstrap = join(home, "real-keyring.cjs");
  await writeFile(
    keyringBootstrap,
    `const { app } = require("electron");
const { appendFileSync } = require("node:fs");
// Electron 33 fixes the macOS Keychain service/account from the app name
// after the awaited application entry loads. Pin the production name in this
// synchronous preload, before that native phase or any safeStorage call.
app.setName("code-shell");
app.commandLine.removeSwitch("password-store");
app.commandLine.removeSwitch("use-mock-keychain");
if (process.platform === "linux")
  app.commandLine.appendSwitch("password-store", "gnome-libsecret");
appendFileSync(${JSON.stringify(join(home, "real-keyring-bootstrap.jsonl"))}, JSON.stringify({
  pid: process.pid,
  ppid: process.ppid,
  appName: app.getName(),
  mockKeychain: app.commandLine.hasSwitch("use-mock-keychain"),
  passwordStore: app.commandLine.getSwitchValue("password-store"),
  electron: process.versions.electron,
}) + "\\n", { mode: 0o600 });
`,
    { mode: 0o600 },
  );
  const application = await launch({
    timeout,
    args: [
      "--require",
      keyringBootstrap,
      ...(mainBootstrap ? ["--require", mainBootstrap] : []),
      `--user-data-dir=${userDataDir ?? join(home, "electron-user-data")}`,
      mainEntry ?? appDir,
    ],
    cwd: appDir,
    env: environment,
  });
  try {
    watch(application.process(), { timeoutMs: runtimeTimeoutMs });
  } catch (error) {
    await application.close().catch(() => {});
    throw error;
  }
  return application;
}

export async function findCodeShellWindow(app, options = {}) {
  const timeout = options.timeout ?? 20_000;
  await app.firstWindow({ timeout });
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const candidate of app.windows()) {
      const hasRoot = await candidate
        .locator("#root")
        .waitFor({ state: "attached", timeout: Math.min(500, Math.max(1, deadline - Date.now())) })
        .then(
          () => true,
          () => false,
        );
      if (hasRoot) {
        await candidate
          .waitForLoadState("domcontentloaded", {
            timeout: Math.max(1, deadline - Date.now()),
          })
          .catch(() => undefined);
        return candidate;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("CodeShell renderer window was not found");
}

export function captureRendererErrors(win) {
  const errors = [];
  win.on("pageerror", (error) => {
    errors.push(error);
    console.error("renderer pageerror:", error.message);
  });
  return errors;
}

/** Wait for resize and expand the current sidebar surface through its real toggle. */
export async function expandSidebar(win) {
  const toggle = win.locator('[data-sidebar-action="toggle"]');
  await toggle.waitFor({ state: "visible" });
  // Resize dispatch can lag setViewportSize. Wait for useResponsiveSidebar's
  // 640px breakpoint to reach the topbar before toggling either surface.
  await win.waitForFunction(() => {
    const toggle = document.querySelector('[data-sidebar-action="toggle"]');
    return (
      toggle && (toggle.getAttribute("aria-haspopup") === "dialog") === window.innerWidth < 640
    );
  });
  // An expanded sidebar can still be mounting after resize. Inspect its
  // authoritative toggle state instead of collapsing it when a child is absent.
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  await win.locator("#codeshell-sidebar-navigation").waitFor({ state: "visible" });
}

/** Open the production account menu, including the narrow-window drawer. */
export async function openSettingsMenu(win) {
  const menu = win.getByRole("menu", { name: /^(账号管理|Manage account)$/ });
  if (await menu.isVisible()) return menu;
  await expandSidebar(win);
  const trigger = win.locator('#codeshell-sidebar-navigation button[aria-haspopup="menu"]');
  await trigger.click();
  await menu.waitFor({ state: "visible" });
  return menu;
}

/** Navigate through real menu items rather than setting persisted route state. */
export async function navigateSettingsMenu(win, label, { activity = false } = {}) {
  const settings = await openSettingsMenu(win);
  let menu = settings;
  if (activity) {
    await settings.getByRole("menuitem", { name: /^(活动记录|Activity)$/ }).click();
    menu = win.getByRole("menu", { name: /^(活动记录|Activity)$/ });
    await menu.waitFor({ state: "visible" });
  }
  await menu.getByRole("menuitem", { name: label, exact: true }).click();
  // Navigation runs after Radix releases its pointer and focus locks.
  await settings.waitFor({ state: "hidden" });
}

/** Seed synthetic sidebar metadata through the same durable API used by the UI.
 * Writing legacy localStorage after startup is deliberately ignored once the
 * one-time catalog migration has completed. */
export async function seedSessionCatalog(win, indices, { replace = false } = {}) {
  await win.evaluate(
    async ({ seed, replace }) => {
      const current = await window.codeshell.sessionCatalog.load();
      const projectKeys = new Set([
        ...Object.keys(seed),
        ...(replace ? Object.keys(current.indices) : []),
      ]);
      for (const projectKey of projectKeys) {
        const index = seed[projectKey] ?? { sessions: [], activeSessionId: null };
        const ids = new Set(index.sessions.map((session) => session.id));
        await window.codeshell.sessionCatalog.apply({
          projectKey,
          upserts: index.sessions.map((session) => ({ id: session.id, values: session })),
          ...(replace
            ? {
                deletedSessionIds: (current.indices[projectKey]?.sessions ?? [])
                  .filter((session) => !ids.has(session.id))
                  .map((session) => session.id),
              }
            : {}),
          activeSessionId: index.activeSessionId,
          ...(replace || index.deletedProjectLabel !== undefined
            ? { deletedProjectLabel: index.deletedProjectLabel ?? null }
            : {}),
        });
      }
    },
    { seed: indices, replace },
  );
}

export async function waitForSessionCatalogSelection(win, projectKey, sessionId) {
  await win.waitForFunction(
    async ({ projectKey, sessionId }) =>
      (await window.codeshell.sessionCatalog.load()).indices[projectKey]?.activeSessionId ===
      sessionId,
    { projectKey, sessionId },
    { polling: 100 },
  );
}
