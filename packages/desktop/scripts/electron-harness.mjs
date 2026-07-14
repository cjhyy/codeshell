/* global document */
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
        .evaluate(() => Boolean(document.getElementById("root")))
        .catch(() => false);
      if (hasRoot) {
        await candidate.waitForLoadState("domcontentloaded").catch(() => undefined);
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
