/* global document, window */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  ensureElectronKeychainContext,
  getElectronKeychainPreflightDiagnostic,
} from "./electron-keychain-preflight.mjs";
import { watchElectronTestProcess } from "./electron-test-watchdog.mjs";

const windowsSourceMainIdentityReaders = new WeakMap();

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const diagnosticPhases = new Set([
  "harness-preflight",
  "harness-bootstrap",
  "harness-windows-transport",
  "harness-launch",
  "harness-main-identity",
  "harness-watch",
  "harness-ready",
  "startup-find-renderer",
  "startup-worker-guard",
  "startup-runtime",
  "startup-cold-pet",
  "startup-reload",
  "startup-reload-pet",
  "startup-second-window",
  "startup-second-window-pet",
  "startup-second-window-close",
  "startup-graceful-close",
  "startup-custody",
  "startup-cycle-gates",
]);

export function electronChildExitState(child) {
  try {
    return {
      pid: child?.pid ?? null,
      exitCode: child?.exitCode ?? null,
      signalCode: child?.signalCode ?? null,
      exitObserved: child ? child.exitCode != null || child.signalCode != null : null,
    };
  } catch {
    return { pid: null, exitCode: null, signalCode: null, exitObserved: null, readFailed: true };
  }
}

/** Diagnostic failure must never prevent the existing custody operation. */
export function observeElectronDiagnostic(diagnostics, method, ...args) {
  try {
    return diagnostics?.[method]?.(...args);
  } catch {
    try {
      diagnostics.receipt.recordingFailed = true;
    } catch {
      // Even an invalid diagnostic observer confers no right to alter cleanup.
    }
    return undefined;
  }
}

/** Evidence only: never confers process authority or changes an acceptance gate. */
export function createElectronTestDiagnostics({ ownedRoots = [], additionalPhases = [] } = {}) {
  const allowedPhases = new Set([...diagnosticPhases, ...additionalPhases]);
  const normalize = (text) => {
    const path = text.replace(/\\/g, "/");
    return process.platform === "win32" ? path.toLowerCase() : path;
  };
  const roots = ownedRoots.map((path) => normalize(path).replace(/\/+$/, "") + "/");
  const receipt = {
    phase: null,
    firstError: null,
    cleanups: [],
    signals: [],
    exits: [],
    timeline: [],
    truncated: false,
    boundary:
      "Observed ChildProcess states and cleanup signal requests; not OS liveness or all OS signals",
  };
  const started = performance.now();
  let sequence = 0;
  const event = (kind, fields) => {
    const record = {
      sequence: ++sequence,
      elapsedMs: performance.now() - started,
      kind,
      ...fields,
    };
    if (receipt.timeline.length < 256) receipt.timeline.push(record);
    else receipt.truncated = true;
    return record;
  };
  return {
    receipt,
    phase(phase) {
      assert(allowedPhases.has(phase), "Unknown Electron diagnostic phase");
      receipt.phase = phase;
      event("phase", { phase });
    },
    error(error, child) {
      if (receipt.firstError) return;
      let keychainDiagnostic, name, message, stack;
      try {
        keychainDiagnostic = getElectronKeychainPreflightDiagnostic(error);
        message = keychainDiagnostic
          ? "Keychain metadata preflight refused startup"
          : String(error?.message ?? error).slice(0, 4096);
        name = String(error?.name ?? "Error").slice(0, 120);
        stack = keychainDiagnostic
          ? ""
          : String(error?.stack ?? "")
              .split(/\r?\n/)
              .filter(
                (line) =>
                  /^\s+at /.test(line) && roots.some((root) => normalize(line).includes(root)),
              )
              .slice(0, 16)
              .join("\n")
              .slice(0, 16384);
      } catch {
        name = "Error";
        message = "Uninspectable thrown value";
        stack = "";
        keychainDiagnostic = null;
      }
      receipt.firstError = event("first-error", {
        phase: receipt.phase,
        child: electronChildExitState(child),
        name,
        message,
        stack,
        stackScope: "owned-path-frames-only",
        keychainDiagnostic,
      });
    },
    cleanup(trigger, child) {
      if (!["harness-error", "cycle-error", "cycle-complete"].includes(trigger))
        trigger = "diagnostic-recording-error";
      const record = event("cleanup-start", {
        trigger,
        phase: receipt.phase,
        before: electronChildExitState(child),
        requests: [],
      });
      if (receipt.cleanups.length < 16) receipt.cleanups.push(record);
      else receipt.truncated = true;
      return record;
    },
    request(cleanup, method, child) {
      if (!["application.close", "monitor.terminate"].includes(method))
        method = "diagnostic-recording-error";
      const request = event("cleanup-request", { method, before: electronChildExitState(child) });
      if (cleanup.requests.length < 8) cleanup.requests.push(request);
      else receipt.truncated = true;
    },
    settled(cleanup, child) {
      cleanup.after = electronChildExitState(child);
      event("cleanup-settled", { trigger: cleanup.trigger, after: cleanup.after });
    },
    signal(pid, signal) {
      if (receipt.signals.length < 256)
        receipt.signals.push(event("observed-cleanup-signal-request", { pid, signal }));
      else receipt.truncated = true;
    },
    exit(kind, code, signal) {
      if (receipt.exits.length < 4) receipt.exits.push(event(kind, { code, signal }));
      else receipt.truncated = true;
    },
  };
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

/**
 * Freeze Main's first-run plugin bootstrap through its persisted seam.
 *
 * On every fresh HOME, Main registers the seed marketplaces and installs the
 * core plugins in the background. Those are `git clone` subprocesses, so a
 * fixture's in-process fetch/http deny guard does not stop them; on a networked
 * host they land seconds after launch and rewrite the installed capability
 * inventory mid-test (a reviewed Profile switch then correctly turns stale).
 * Marking every seed entry as already handled keeps the inventory to exactly
 * what the fixture seeded. Call before launch; check with
 * `assertOfflinePluginBootstrapHeld` before cleanup.
 */
export async function seedOfflinePluginBootstrap(codeShellHome) {
  const pluginsDir = join(codeShellHome, "plugins");
  await mkdir(pluginsDir, { recursive: true });
  await writeFile(
    join(pluginsDir, "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: {} }),
  );
  await writeFile(
    join(pluginsDir, "core_plugins_installed.json"),
    JSON.stringify({
      "skill-creator@mimi-plugins": "synthetic-offline-fixture",
      "model-fact-finder@mimi-plugins": "synthetic-offline-fixture",
    }),
  );
  await writeFile(
    join(pluginsDir, "known_marketplaces.json"),
    JSON.stringify(
      Object.fromEntries(
        ["official", "mimi-plugins"].map((name) => [
          name,
          {
            source: { source: "github", repo: "synthetic/offline" },
            installLocation: join(pluginsDir, "offline", name),
            lastUpdated: "2026-10-09T00:00:00Z",
          },
        ]),
      ),
    ),
  );
}

/** Fail loudly if Main still cloned or installed anything during the fixture. */
export async function assertOfflinePluginBootstrapHeld(codeShellHome) {
  const pluginsDir = join(codeShellHome, "plugins");
  const installed = JSON.parse(await readFile(join(pluginsDir, "installed_plugins.json"), "utf8"));
  assert(
    Object.keys(installed.plugins ?? {}).length === 0,
    `First-run plugin bootstrap installed plugins during the fixture: ${Object.keys(installed.plugins).join(", ")}`,
  );
  const known = JSON.parse(await readFile(join(pluginsDir, "known_marketplaces.json"), "utf8"));
  assert(
    Object.values(known).every((entry) => entry?.source?.repo === "synthetic/offline"),
    "First-run plugin bootstrap registered a real marketplace during the fixture",
  );
}

/** A launcher PID is not evidence that the connected Electron Main owns it. */
export async function verifyElectronMainIdentity(
  application,
  { executable, home, parentPid = process.pid },
) {
  const child = application.process();
  assert(
    Number.isSafeInteger(child?.pid) && child.pid > 0,
    "Actual Electron child PID is required",
  );
  const read = windowsSourceMainIdentityReaders.get(application);
  const identity = read
    ? await read()
    : await application.evaluate(() => ({
        pid: process.pid,
        ppid: process.ppid,
        executable: process.execPath,
        home: process.env.HOME,
      }));
  assert(identity.pid === child.pid, "Connected Main PID differs from the direct captured child");
  assert(
    identity.ppid === parentPid,
    "Connected Main parent differs from the owned fixture process",
  );
  assert(identity.home === home, "Connected Main HOME differs from the owned fixture");
  assert(
    (await realpath(identity.executable)) === (await realpath(executable)),
    "Connected Main executable differs from the captured executable",
  );
  return identity;
}

/** Read the live transport ledger after close, before accepting/removing HOME. */
export function assertSourceElectronTransportSettled(
  child,
  { required = process.platform === "win32" } = {},
) {
  const read = child?.__sourceWindowsTransportRead;
  assert(!required || typeof read === "function", "Windows Main transport custody is missing");
  if (!read) return null;
  const receipt = read();
  assert(
    receipt.directMain && receipt.pid === child.pid,
    "Windows transport does not own this direct Main",
  );
  assert(receipt.nativeTaskkillExecuted === false, "Native taskkill must never execute");
  assert(
    receipt.failures.length === 0 && receipt.cleanupRequests.length === 0,
    "Windows transport requested unsafe or forced cleanup",
  );
  return receipt;
}

async function sourceWindowsLaunchDetails() {
  const require = createRequire(import.meta.url);
  const packageFile = require.resolve("playwright-core/package.json");
  return {
    executable: await realpath(require("electron")),
    loader: await realpath(join(dirname(packageFile), "lib/server/electron/loader.js")),
    playwrightVersion: require("playwright-core/package.json").version,
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
    reportFailure = (message) => {
      console.error(message);
      process.exitCode = 1;
    },
    platform = process.platform,
    windowsLaunchDetails = sourceWindowsLaunchDetails,
    diagnostics,
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
    CODE_SHELL_TEST_HOME: join(home, ".code-shell"),
    CODE_SHELL_NO_DEVTOOLS: "1",
    CODE_SHELL_DISABLE_UPDATE_CHECK: "1",
    DISABLE_AUTOUPDATER: "1",
    ...env,
  };
  // Metadata checks happen before even loading Playwright. A missing default
  // must fail here instead of entering macOS's create/reset-Keychain dialog.
  diagnostics?.phase("harness-preflight");
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
  diagnostics?.phase("harness-bootstrap");
  await writeFile(
    keyringBootstrap,
    `const { app } = require("electron");
const { appendFileSync } = require("node:fs");
if (process.platform === "linux" && app.commandLine.hasSwitch("no-sandbox"))
  throw new Error("Owned Electron acceptance refused no-sandbox");
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
  noSandboxSwitch: app.commandLine.hasSwitch("no-sandbox"),
  electron: process.versions.electron,
}) + "\\n", { mode: 0o600 });
`,
    { mode: 0o600 },
  );
  const options = {
    timeout,
    // Playwright otherwise prepends --no-sandbox on Linux. The CI owns and
    // configures these Electron helpers; missing sandbox support must fail.
    chromiumSandbox: true,
    args: [
      "--require",
      keyringBootstrap,
      ...(mainBootstrap ? ["--require", mainBootstrap] : []),
      `--user-data-dir=${userDataDir ?? join(home, "electron-user-data")}`,
      mainEntry ?? appDir,
    ],
    cwd: appDir,
    env: environment,
  };
  if (platform === "win32") {
    diagnostics?.phase("harness-windows-transport");
    const details = await windowsLaunchDetails();
    const { installWindowsElectronDirectTransport, createWindowsSourceMainIdentityReader } =
      await import("./windows-electron-direct-transport.mjs");
    let captured, custody;
    const transport = installWindowsElectronDirectTransport({
      ...details,
      args: options.args,
      home,
      cwd: appDir,
      platform,
      reportFailure,
      onCapturedSpawn(child) {
        assert(captured === undefined, "Only one direct Main can be captured");
        captured = child;
        child.__sourceWindowsTransportRead = () => transport.receipt();
        custody = watch(child, { timeoutMs: runtimeTimeoutMs, reportFailure });
        assert(
          typeof custody?.terminate === "function" &&
            typeof custody?.completed?.then === "function",
          "Windows launch requires early birth custody before handshake",
        );
        return custody;
      },
    });
    try {
      diagnostics?.phase("harness-launch");
      const application = await launch(options);
      diagnostics?.phase("harness-main-identity");
      assert(
        captured && application.process() === captured,
        "Playwright must expose the captured direct Main",
      );
      const readIdentity = await createWindowsSourceMainIdentityReader({
        application,
        captured,
        playwrightVersion: details.playwrightVersion,
        platform,
      });
      windowsSourceMainIdentityReaders.set(application, readIdentity);
      application.__sourceMainIdentity = await verifyElectronMainIdentity(application, {
        executable: details.executable,
        home,
      });
      application.__sourceWindowsTransport = transport.receipt();
      diagnostics?.phase("harness-ready");
      return application;
    } catch (error) {
      observeElectronDiagnostic(diagnostics, "error", error, captured);
      const cleanup = observeElectronDiagnostic(diagnostics, "cleanup", "harness-error", captured);
      // Never route Playwright's taskkill or an ordinary app.close without
      // identity. The same early monitor owns any permitted termination.
      try {
        if (typeof custody?.terminate === "function") {
          if (cleanup)
            observeElectronDiagnostic(
              diagnostics,
              "request",
              cleanup,
              "monitor.terminate",
              captured,
            );
          await custody.terminate();
        } else {
          captured?.unref();
          captured?.stdout?.unref?.();
          captured?.stderr?.unref?.();
        }
      } finally {
        if (cleanup) {
          observeElectronDiagnostic(diagnostics, "settled", cleanup, captured);
        }
      }
      throw error;
    } finally {
      transport.restoreSpawn();
      syncBuiltinESMExports();
    }
  }
  diagnostics?.phase("harness-launch");
  const application = await launch(options);
  try {
    diagnostics?.phase("harness-watch");
    watch(application.process(), { timeoutMs: runtimeTimeoutMs, reportFailure });
  } catch (error) {
    // An unsuccessful birth query grants no quit/signal authority.
    const child = application.process();
    child?.unref?.();
    child?.stdout?.unref?.();
    child?.stderr?.unref?.();
    throw error;
  }
  diagnostics?.phase("harness-ready");
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
  await waitForAsyncFunction(
    win,
    async ({ projectKey, sessionId }) =>
      (await window.codeshell.sessionCatalog.load()).indices[projectKey]?.activeSessionId ===
      sessionId,
    { projectKey, sessionId },
    { polling: 100 },
  );
}

/** Await each IPC result in the controller. Playwright's page predicate poller
 * can accept a Promise as truthy before its eventual false value is known. */
export async function waitForAsyncFunction(
  win,
  predicate,
  arg,
  { timeout = 30_000, polling = 100 } = {},
) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let timer;
    let value;
    try {
      value = await Promise.race([
        win.evaluate(predicate, arg),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Timed out waiting for an asynchronous UI condition")),
            Math.max(0, deadline - Date.now()),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (value) return value;
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for an asynchronous UI condition");
    await new Promise((done) => setTimeout(done, polling));
  }
}
