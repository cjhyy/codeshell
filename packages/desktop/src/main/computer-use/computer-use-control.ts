import { join } from "node:path";
import { ComputerActivityBus } from "./computer-activity-bus.js";
import { createCuaActivityServer } from "./cua-activity-server.js";
import { InputGate, UserActivityMonitor } from "./input-gate.js";

/** Global emergency stop for computer input while a CUA connection is live. */
export const STOP_INPUT_ACCELERATOR = "CommandOrControl+Shift+Escape";

/**
 * Acceptance seam, unset by default and ignored by a packaged app: an
 * UNPACKAGED build keeps the stop shortcut off the real keyboard, so an
 * acceptance run next to an installed CodeShell never competes for its key.
 * `virtual` accepts the registration and exposes the callback as
 * `globalThis[STOP_SHORTCUT_HOOK]`; `unavailable` refuses it. Read at each
 * registration.
 */
export const STOP_SHORTCUT_OVERRIDE_ENV = "CODESHELL_E2E_STOP_SHORTCUT";
export const STOP_SHORTCUT_HOOK = "__codeshellE2eStopShortcut";

type StopShortcut = NonNullable<ComputerUseControlOptions["shortcut"]>;

export function stopShortcutBinding(options: {
  native: StopShortcut;
  env: NodeJS.ProcessEnv;
  isPackaged: boolean;
  hooks?: { [STOP_SHORTCUT_HOOK]?: () => void };
}): StopShortcut {
  const hooks = options.hooks ?? (globalThis as { [STOP_SHORTCUT_HOOK]?: () => void });
  const override = () => (options.isPackaged ? undefined : options.env[STOP_SHORTCUT_OVERRIDE_ENV]);
  let virtual = false;
  return {
    register(accelerator, callback) {
      const mode = override();
      if (mode === "unavailable") return false;
      if (mode !== "virtual") return options.native.register(accelerator, callback);
      hooks[STOP_SHORTCUT_HOOK] = callback;
      virtual = true;
      return true;
    },
    unregister(accelerator) {
      if (!virtual) return options.native.unregister(accelerator);
      delete hooks[STOP_SHORTCUT_HOOK];
      virtual = false;
    },
  };
}

export interface ComputerUseControlOptions {
  appPath: string;
  /** Bundled app profiles (resources/computer-use/apps), read by every proxy. */
  appProfilesDir?: string;
  executablePath: string;
  log(event: string, data?: Record<string, unknown>): void;
  /** Seconds since the last keyboard/mouse input. Omit to skip user-activity holds. */
  idleSeconds?(): number;
  shortcut?: {
    register(accelerator: string, callback: () => void): boolean;
    unregister(accelerator: string): void;
  };
  /** User-visible confirmation that a stop took effect. */
  notifyStopped?(): void;
}

/** The execution side of Computer Use: one gate, one activity bus, and the
 * private socket every MCP proxy uses. Independent of any character window. */
export async function createComputerUseControl(options: ComputerUseControlOptions) {
  const gate = new InputGate();
  const bus = new ComputerActivityBus();
  const monitor = options.idleSeconds
    ? new UserActivityMonitor({ gate, idleSeconds: options.idleSeconds })
    : undefined;
  let shortcutActive = false;
  // A connection is live but the last registration was refused: the user has
  // no keyboard stop and must be told to use the on-screen one.
  let shortcutUnavailable = false;

  const stopInput = (source: string) => {
    const wasStopped = gate.status().stopped;
    gate.stopAll();
    options.log("computer_input_stopped", { source });
    if (!wasStopped) options.notifyStopped?.();
  };
  const resumeInput = (source: string) => {
    gate.resume();
    options.log("computer_input_resumed", { source });
  };

  const setLive = (live: boolean) => {
    if (live) monitor?.start();
    else monitor?.stop();
    if (!live) shortcutUnavailable = false;
    if (!options.shortcut || live === shortcutActive) return;
    if (live) {
      shortcutActive = options.shortcut.register(STOP_INPUT_ACCELERATOR, () =>
        stopInput("shortcut"),
      );
      if (!shortcutActive && !shortcutUnavailable)
        options.log("computer_input_shortcut_unavailable", { accelerator: STOP_INPUT_ACCELERATOR });
      shortcutUnavailable = !shortcutActive;
    } else {
      options.shortcut.unregister(STOP_INPUT_ACCELERATOR);
      shortcutActive = false;
    }
  };

  const server = await createCuaActivityServer({
    onOperation: (event) => {
      monitor?.observe(event);
      return bus.publish(event);
    },
    gate,
    onConnections: (count) => setLive(count > 0),
  });

  return {
    gate,
    bus,
    stopInput,
    resumeInput,
    /** The gate as shown to the user, with whether the keyboard stop is missing. */
    inputStatus: () => ({ ...gate.status(), shortcutUnavailable }),
    mcpProxy: {
      command: options.executablePath,
      entryPath: join(options.appPath, "out", "main", "cua-activity-proxy.mjs"),
      socketPath: server.socketPath,
      token: server.token,
      ...(options.appProfilesDir ? { appProfilesDir: options.appProfilesDir } : {}),
    },
    async close() {
      setLive(false);
      await server.close();
    },
  };
}

export type ComputerUseControl = Awaited<ReturnType<typeof createComputerUseControl>>;
