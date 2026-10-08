/* global document, window */
import { _electron as electron } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function makeIsolatedElectronHome(prefix = "codeshell-electron-e2e-") {
  const home = await mkdtemp(join(tmpdir(), prefix));
  return {
    home,
    codeShellHome: join(home, ".code-shell"),
    userDataDir: join(home, "electron-user-data"),
    cleanup: () => rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
  };
}

export async function launchCodeShellElectron({ appDir, home, userDataDir, env = {} }) {
  return electron.launch({
    args: [`--user-data-dir=${userDataDir ?? join(home, "electron-user-data")}`, appDir],
    cwd: appDir,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CODE_SHELL_HOME: join(home, ".code-shell"),
      CODE_SHELL_NO_DEVTOOLS: "1",
      CODE_SHELL_DISABLE_UPDATE_CHECK: "1",
      DISABLE_AUTOUPDATER: "1",
      ...env,
    },
  });
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

/** Open the production settings menu, including the narrow-window drawer. */
export async function openSettingsMenu(win) {
  const menu = win.getByRole("menu", { name: /^(设置|Settings)$/ });
  if (await menu.isVisible()) return menu;
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
  const trigger = win.getByRole("button", { name: /^(设置|Settings)$/ });
  if (!(await trigger.isVisible())) await toggle.click();
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
