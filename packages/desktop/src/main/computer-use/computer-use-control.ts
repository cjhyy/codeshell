import { join } from "node:path";
import { ComputerActivityBus } from "./computer-activity-bus.js";
import { createCuaActivityServer } from "./cua-activity-server.js";
import { InputGate, UserActivityMonitor } from "./input-gate.js";

/** Global emergency stop for computer input while a CUA connection is live. */
export const STOP_INPUT_ACCELERATOR = "CommandOrControl+Shift+Escape";

export interface ComputerUseControlOptions {
  appPath: string;
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
    if (!options.shortcut || live === shortcutActive) return;
    if (live) {
      shortcutActive = options.shortcut.register(STOP_INPUT_ACCELERATOR, () =>
        stopInput("shortcut"),
      );
      if (!shortcutActive) options.log("computer_input_shortcut_unavailable");
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
    mcpProxy: {
      command: options.executablePath,
      entryPath: join(options.appPath, "out", "main", "cua-activity-proxy.mjs"),
      socketPath: server.socketPath,
      token: server.token,
    },
    async close() {
      setLive(false);
      await server.close();
    },
  };
}

export type ComputerUseControl = Awaited<ReturnType<typeof createComputerUseControl>>;
