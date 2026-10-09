import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { confinedWorkerEnvironment } from "../../../scripts/runtime-cost-smoke-isolation.mjs";

/** Test-only bootstrap: Electron may discard NODE_OPTIONS, including for its Node worker. */
export async function prepareConfinedElectronFixture({
  appDir,
  isolated,
  origin,
  guardModule,
  guardReceiptReady = () => true,
}) {
  isolated.home = await realpath(isolated.home);
  isolated.codeShellHome = join(isolated.home, ".code-shell");
  isolated.userDataDir = join(isolated.home, "electron-user-data");
  const guardUrl =
    guardModule ??
    new URL("../../../scripts/runtime-cost-smoke-isolation.mjs", import.meta.url).href;
  const receiptFile = join(isolated.home, "network-guard.jsonl");
  const spawnedWorkerFile = join(isolated.home, "spawned-workers.jsonl");
  const mainEntry = join(isolated.home, "guarded-main.mjs");
  const preload = join(isolated.home, "guarded-runtime.mjs");
  const preloadUrl = pathToFileURL(preload).href;
  // Preserve toolchain/locale/display and the actual OS keyring session. All
  // other inherited Host configuration and authentication is explicitly unset.
  const inheritedKeys = new Set([
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TERM",
    "COLORTERM",
    "DISPLAY",
    "XAUTHORITY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "XDG_CURRENT_DESKTOP",
    "DBUS_SESSION_BUS_ADDRESS",
    "DBUS_SESSION_BUS_PID",
    "GNOME_KEYRING_CONTROL",
    "GNOME_KEYRING_PID",
    "TMPDIR",
    "TMP",
    "TEMP",
    "USER",
    "LOGNAME",
    "USERNAME",
    "SECURITYSESSIONID",
    "CI",
    "GITHUB_ACTIONS",
    "PLAYWRIGHT_BROWSERS_PATH",
    "BUN_INSTALL",
  ]);
  const environment = {};
  const removedEnvironment = {};
  for (const [key, value] of Object.entries(process.env))
    if (inheritedKeys.has(key)) environment[key] = value;
    else {
      // launchCodeShellElectron merges its caller's process.env first. Explicit
      // undefined values must also remove inherited values in that layer.
      removedEnvironment[key] = undefined;
    }
  await writeFile(
    preload,
    `if (process.env.CODE_SHELL_HOME !== ${JSON.stringify(isolated.codeShellHome)} ||
    process.env.CODE_SHELL_TEST_HOME !== ${JSON.stringify(isolated.codeShellHome)} ||
    process.env.CODE_SHELL_DATA_ROOT !== undefined)
  throw new Error("Electron fixture refused an unexpected storage context");
await import(${JSON.stringify(guardUrl)});
`,
    { mode: 0o600 },
  );
  await writeFile(
    mainEntry,
    `import { app } from "electron";
import children from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
await import(${JSON.stringify(preloadUrl)});
app.setAppPath(${JSON.stringify(appDir)});
const spawn = children.spawn;
children.spawn = function (command, args, options) {
  const worker = args?.some((argument) => argument.includes("agent-server-stdio"));
  if (worker)
    args = ["--import", ${JSON.stringify(preloadUrl)}, ...args];
  const child = spawn.call(this, command, args, options);
  if (worker && child.pid) {
    // Hold all protocol input until the parent verifies this exact worker's
    // bootstrap receipt. Core can load, but no model task reaches the worker.
    child.stdin.cork();
    const timer = setInterval(() => {
      if (existsSync(${JSON.stringify(join(isolated.home, "worker-"))} + child.pid + ".permit")) {
        clearInterval(timer);
        child.stdin.uncork();
      }
    }, 10);
    timer.unref();
    child.once("exit", () => clearInterval(timer));
    appendFileSync(${JSON.stringify(spawnedWorkerFile)}, JSON.stringify({ pid: child.pid }) + "\\n", { mode: 0o600 });
  }
  return child;
};
syncBuiltinESMExports();
await import(${JSON.stringify(pathToFileURL(join(appDir, "out/main/index.mjs")).href)});
`,
    { mode: 0o600 },
  );
  return {
    mainEntry,
    env: {
      ...removedEnvironment,
      ...confinedWorkerEnvironment(environment, isolated.home, origin, preloadUrl),
      CODE_SHELL_HOME: isolated.codeShellHome,
      CODE_SHELL_TEST_HOME: isolated.codeShellHome,
      CODE_SHELL_NO_DEVTOOLS: "1",
      CODE_SHELL_DISABLE_UPDATE_CHECK: "1",
      DISABLE_AUTOUPDATER: "1",
      XDG_CONFIG_HOME: join(isolated.home, ".config"),
      XDG_DATA_HOME: join(isolated.home, ".local", "share"),
      CODESHELL_COST_SMOKE_GUARD_LOG: receiptFile,
    },
    async assertWorker(app) {
      const pid = app.process().pid;
      const homeId = createHash("sha256").update(isolated.home).digest("hex");
      const deadline = Date.now() + 15_000;
      let lastReceipts;
      let lastSpawned;
      do {
        const receipts = (await readFile(receiptFile, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const spawned = (await readFile(spawnedWorkerFile, "utf8").catch(() => ""))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        lastReceipts = receipts;
        lastSpawned = spawned;
        if (receipts.some((receipt) => receipt.origin !== origin || receipt.homeId !== homeId))
          throw new Error("Electron fixture received a mismatched network/home receipt");
        if (
          receipts.some((receipt) => receipt.pid === pid && guardReceiptReady(receipt)) &&
          spawned.length > 0 &&
          spawned.every((worker) =>
            receipts.some(
              (receipt) =>
                receipt.pid === worker.pid && receipt.ppid === pid && guardReceiptReady(receipt),
            ),
          )
        ) {
          for (const worker of spawned)
            await writeFile(join(isolated.home, `worker-${worker.pid}.permit`), "verified", {
              mode: 0o600,
            });
          console.log(
            "Electron fixture: Main and actual spawned worker network/home confinement verified",
          );
          return { mainPid: pid, homeId, receipts, spawned };
        }
        await new Promise((done) => setTimeout(done, 100));
      } while (Date.now() < deadline);
      throw new Error(
        `Electron fixture requires the Main and actual worker's exact network/home receipts: ${JSON.stringify({ mainPid: pid, receipts: lastReceipts, spawned: lastSpawned })}`,
      );
    },
  };
}
