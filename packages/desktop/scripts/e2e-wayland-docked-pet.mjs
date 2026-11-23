/* global window */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { checkDockedPetWindow } from "./docked-pet-window.mjs";
import {
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
  seedOfflinePluginBootstrap,
} from "./electron-harness.mjs";
import { readPackagedLinuxEnvironment } from "./packaged-linux-environment.mjs";
import { settingsNetworkGuard } from "./settings-network-guard.mjs";

// The isolated runner's private SecretService also owns this 0700 runtime directory.
const { XDG_RUNTIME_DIR } = readPackagedLinuxEnvironment();
const isolated = await makeIsolatedElectronHome("codeshell-wayland-pet-");
const socket = "wayland-mimi";
const environment = {
  DISPLAY: "",
  XDG_SESSION_TYPE: "wayland",
  WAYLAND_DISPLAY: socket,
  XDG_RUNTIME_DIR,
};
const title = "CodeShell-Mimi-Wayland-Probe";
const weston = spawn(
  "weston",
  [
    "--backend=headless-backend.so",
    "--renderer=pixman",
    "--no-config",
    "--idle-time=0",
    `--socket=${socket}`,
  ],
  {
    env: { ...process.env, ...environment, HOME: isolated.home, WAYLAND_DEBUG: "server" },
    stdio: ["ignore", "ignore", "pipe"],
  },
);
let ended = false;
let failure;
const closed = new Promise((resolve) => {
  weston.once("error", (error) => {
    failure = error;
  });
  weston.once("close", () => {
    ended = true;
    resolve();
  });
});
let labeled = false;
let lastLog = "";
createInterface({ input: weston.stderr }).on("line", (line) => {
  if (line.includes("xdg_toplevel") && line.includes(`.set_title("${title}")`)) labeled = true;
  lastLog = (lastLog + line + "\n").slice(-2400);
});
async function waitFor(check, description) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (failure) throw failure;
    if (ended) throw new Error(`Weston exited before ${description}\n${lastLog}`);
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}\n${lastLog}`);
}
let app;
try {
  await waitFor(
    () =>
      stat(join(XDG_RUNTIME_DIR, socket)).then(
        (s) => s.isSocket(),
        () => false,
      ),
    "the private Wayland socket",
  );
  await seedOfflinePluginBootstrap(isolated.codeShellHome);
  const guard = await settingsNetworkGuard(isolated.home);
  app = await launchCodeShellElectron({
    appDir: dirname(fileURLToPath(new URL("../package.json", import.meta.url))),
    home: isolated.home,
    userDataDir: isolated.userDataDir,
    mainBootstrap: guard.mainBootstrap,
    env: { ...guard.env, ...environment },
  });
  const win = await findCodeShellWindow(app);
  await checkDockedPetWindow(app, win, async (handle) => {
    const state = await handle.evaluate((widget, title) => {
      widget.setTitle(title);
      return {
        visible: widget.isVisible(),
        size: widget.getSize(),
        content: widget.getContentSize(),
      };
    }, title);
    assert.equal(state.visible, true);
    assert(state.size.every((length) => length > 0));
    assert.deepEqual(state.content, state.size, "Docked window has no native frame");
    // An actual xdg_toplevel message for this window proves native Wayland rendering.
    await waitFor(() => labeled, "Weston to observe the docked widget title");
  });
  assert.equal(
    await win.evaluate(async () => (await window.codeshell.pet.getPresence()).shown),
    null,
  );
  console.log("Weston observed the frameless docked Mimi window on Wayland; show and hide passed.");
} finally {
  try {
    await app?.close();
  } finally {
    if (!ended) weston.kill();
    await closed;
    await isolated.cleanup();
  }
}
