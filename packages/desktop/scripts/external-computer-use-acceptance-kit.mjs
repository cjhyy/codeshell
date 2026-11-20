/*
 * Window steps shared by the external-runtime Computer Use acceptance specs
 * (stand-in driver and real driver). Each takes the app/window it acts on, so a
 * spec that relaunches keeps one source of truth for them.
 */
/* global document, window */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { assert, expandSidebar, waitForAsyncFunction } from "./electron-harness.mjs";

export const pause = (ms) => new Promise((done) => setTimeout(done, ms));

export async function waitFor(read, what, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (value) return value;
    assert(Date.now() < deadline, `Timed out waiting for ${what}`);
    await pause(100);
  }
}

export async function dismissTrust(win) {
  const trust = win.getByRole("button", { name: /信任并继续|Trust and continue/i });
  if (
    await trust
      .waitFor({ timeout: 5000 })
      .then(() => true)
      .catch(() => false)
  )
    await trust.click();
}

export async function registerProject(app, win, projectPath) {
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
}

export async function selectModel(win, wanted) {
  const pill = win.locator("button[data-active-model]");
  await pill.waitFor({ state: "visible", timeout: 20_000 });
  if ((await pill.getAttribute("data-active-model")) === wanted) return;
  await pill.click();
  await win.locator(`[data-model-key="${wanted}"]`).click();
  await win.waitForFunction(
    (key) =>
      document.querySelector("button[data-active-model]")?.getAttribute("data-active-model") ===
      key,
    wanted,
  );
}

export async function send(win, text) {
  const composer = win.locator("textarea:visible").last();
  await composer.fill(text);
  await composer.press("Enter");
}

export const approveOnce = (win) =>
  win.getByRole("button", { name: /^(仅本次批准|Approve once)$/ });

/** The scripted `claude`'s `count`th turn; fails if an approval card shows meanwhile. */
export async function claudeTurn(win, cli, count, { timeout = 40_000, noCard = false } = {}) {
  const deadline = Date.now() + timeout;
  while ((await cli.invocations()).length < count) {
    assert(Date.now() < deadline, `Timed out waiting for scripted turn ${count}`);
    if (noCard)
      assert(
        !(await approveOnce(win).first().isVisible()),
        "An approval card was shown unexpectedly",
      );
    await pause(100);
  }
  return (await cli.invocations())[count - 1];
}

/**
 * The stop shortcut as the acceptance seam exposes it
 * (CODESHELL_E2E_STOP_SHORTCUT=virtual): the callback Desktop registered for
 * ⌘⇧Esc, present only while it is registered. No key is ever synthesized and
 * the real system-wide key is never taken from an installed CodeShell.
 */
export const stopShortcutRegistered = (app) =>
  app.evaluate(() => typeof globalThis.__codeshellE2eStopShortcut === "function");

export const pressStopShortcut = (app) =>
  app.evaluate(() => globalThis.__codeshellE2eStopShortcut());

/** Count "stopped" notices instead of showing one (a first notice can ask macOS). */
export const muteStopNotice = (app) =>
  app.evaluate(({ Notification }) => {
    globalThis.__codeshellE2eStopNotices = 0;
    Notification.isSupported = () => {
      globalThis.__codeshellE2eStopNotices += 1;
      return false;
    };
  });

export const stopNotices = (app) => app.evaluate(() => globalThis.__codeshellE2eStopNotices);

/** Desktop main's `computer-use` log records (`msg` is the event), in order. */
export async function computerUseLog(codeShellHome) {
  const directory = join(codeShellHome, "logs", "desktop");
  const files = (await readdir(directory).catch(() => [])).filter((name) =>
    /^desktop-.*\.log$/.test(name),
  );
  const events = [];
  for (const name of files.sort())
    for (const line of (await readFile(join(directory, name), "utf8")).split("\n")) {
      if (!line.includes('"computer-use"')) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        /* a partially flushed last line */
      }
    }
  return events;
}
