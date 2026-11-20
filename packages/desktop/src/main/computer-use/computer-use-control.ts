import { join } from "node:path";
import { ComputerActivityBus } from "./computer-activity-bus.js";
import { createCuaActivityServer } from "./cua-activity-server.js";
import { InputGate, UserActivityMonitor } from "./input-gate.js";
import type { StopShortcutLock, StopShortcutNamespace } from "./stop-shortcut-lock.js";

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

type SyncShortcut = {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
};

/**
 * The stop shortcut as Desktop registers it. With `lock`, a registration first
 * claims the per-user owner file (see stop-shortcut-lock.ts), because macOS
 * reports success to every process registering the same accelerator; register
 * and unregister then settle asynchronously, in call order.
 */
export function stopShortcutBinding(options: {
  native: SyncShortcut;
  env: NodeJS.ProcessEnv;
  isPackaged: boolean;
  hooks?: { [STOP_SHORTCUT_HOOK]?: () => void };
}): SyncShortcut;
export function stopShortcutBinding(options: {
  native: SyncShortcut;
  env: NodeJS.ProcessEnv;
  isPackaged: boolean;
  hooks?: { [STOP_SHORTCUT_HOOK]?: () => void };
  lock: (namespace: StopShortcutNamespace) => StopShortcutLock;
}): StopShortcut;
export function stopShortcutBinding(options: {
  native: SyncShortcut;
  env: NodeJS.ProcessEnv;
  isPackaged: boolean;
  hooks?: { [STOP_SHORTCUT_HOOK]?: () => void };
  lock?: (namespace: StopShortcutNamespace) => StopShortcutLock;
}): StopShortcut {
  const hooks = options.hooks ?? (globalThis as { [STOP_SHORTCUT_HOOK]?: () => void });
  const override = () => (options.isPackaged ? undefined : options.env[STOP_SHORTCUT_OVERRIDE_ENV]);
  let virtual = false;
  const binding: SyncShortcut = {
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
  return options.lock ? coordinated(binding, options.lock, override) : binding;
}

function coordinated(
  inner: SyncShortcut,
  lockFor: (namespace: StopShortcutNamespace) => StopShortcutLock,
  override: () => string | undefined,
): StopShortcut {
  let queue: Promise<unknown> = Promise.resolve();
  let held: StopShortcutLock | undefined;
  let registered = false;
  const releaseOnExit = () => held?.releaseSync();
  const enqueue = <T>(step: () => Promise<T>): Promise<T> => {
    const next = queue.then(step);
    queue = next.catch(() => undefined);
    return next;
  };
  const release = async () => {
    const owner = held;
    held = undefined;
    process.off("exit", releaseOnExit);
    await owner?.release().catch(() => undefined);
  };
  return {
    register: (accelerator, callback) =>
      enqueue(async () => {
        if (registered) return true;
        const mode = override();
        if (mode === "unavailable") return false;
        const owner = lockFor(mode === "virtual" ? "virtual" : "native");
        if (!(await owner.acquire().catch(() => false))) return false;
        held = owner;
        process.on("exit", releaseOnExit);
        registered = inner.register(accelerator, callback);
        if (!registered) await release();
        return registered;
      }),
    unregister: (accelerator) =>
      enqueue(async () => {
        if (registered) inner.unregister(accelerator);
        registered = false;
        await release();
      }),
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
  /** May settle asynchronously (cross-instance claim); calls apply in order. */
  shortcut?: {
    register(accelerator: string, callback: () => void): boolean | Promise<boolean>;
    unregister(accelerator: string): void | Promise<void>;
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
  let wantLive = false;
  let registering = false;
  // Bumped by every unregister: an older registration's outcome is void.
  let generation = 0;
  let unregistered: Promise<void> = Promise.resolve();

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

  const settle = (attempt: number, registered: boolean) => {
    registering = false;
    if (attempt !== generation) {
      // Unregistered meanwhile (queued after this attempt); claim again if live.
      if (wantLive) setLive(true);
      return;
    }
    shortcutActive = registered;
    if (!registered && !shortcutUnavailable)
      options.log("computer_input_shortcut_unavailable", { accelerator: STOP_INPUT_ACCELERATOR });
    shortcutUnavailable = !registered;
  };
  const setLive = (live: boolean) => {
    wantLive = live;
    if (live) monitor?.start();
    else monitor?.stop();
    if (!live) shortcutUnavailable = false;
    const shortcut = options.shortcut;
    if (!shortcut) return;
    if (live) {
      if (shortcutActive || registering) return;
      registering = true;
      const attempt = generation;
      const result = shortcut.register(STOP_INPUT_ACCELERATOR, () => stopInput("shortcut"));
      if (typeof result === "boolean") settle(attempt, result);
      else
        result.then(
          (registered) => settle(attempt, registered),
          () => settle(attempt, false),
        );
    } else {
      if (!shortcutActive && !registering) return;
      generation++;
      shortcutActive = false;
      unregistered = Promise.resolve(shortcut.unregister(STOP_INPUT_ACCELERATOR)).catch(
        () => undefined,
      );
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
      // The cross-instance claim is released before the app goes away.
      await unregistered;
      await server.close();
    },
  };
}

export type ComputerUseControl = Awaited<ReturnType<typeof createComputerUseControl>>;
