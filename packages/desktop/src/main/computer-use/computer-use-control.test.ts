import { expect, test } from "bun:test";
import { createConnection, type Socket } from "node:net";
import {
  createComputerUseControl,
  STOP_INPUT_ACCELERATOR,
  STOP_SHORTCUT_HOOK,
  STOP_SHORTCUT_OVERRIDE_ENV,
  stopShortcutBinding,
} from "./computer-use-control";

test("global stop gates computer input without cancelling the owning Run", async () => {
  let notices = 0;
  const runs: unknown[] = [];
  const control = await createComputerUseControl({
    appPath: "/fixture",
    executablePath: process.execPath,
    log() {},
    notifyStopped() {
      notices++;
    },
  });
  try {
    control.bus.subscribe({
      onOperation() {},
      onRun(run) {
        runs.push(run);
      },
    });
    await control.bus.publish({
      id: "operation",
      sessionId: "running-session",
      action: "click",
      phase: "start",
      capture: false,
    });
    control.stopInput("test");
    control.stopInput("test");
    expect(control.gate.status().stopped).toBe(true);
    expect(control.gate.snapshot().cancelledSessions).toEqual([]);
    expect(runs).toEqual([]);
    expect(notices).toBe(1);
    control.resumeInput("test");
    expect(control.gate.status().stopped).toBe(false);
    // Run completion remains owned by the agent lifecycle, independently of input.
    control.bus.publishRun("running-session", "completed");
    expect(runs).toEqual([{ sessionId: "running-session", outcome: "completed" }]);
  } finally {
    await control.close();
  }
});

/** A proxy's authenticated hello is what makes a connection live. */
async function connectProxy(proxy: { socketPath: string; token: string }): Promise<Socket> {
  const socket = createConnection(proxy.socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  socket.write(JSON.stringify({ token: proxy.token, type: "hello" }) + "\n");
  return socket;
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition was not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("the stop shortcut is held only while a proxy is connected and stops all input", async () => {
  const registered = new Map<string, () => void>();
  const events: string[] = [];
  const control = await createComputerUseControl({
    appPath: "/fixture",
    executablePath: process.execPath,
    log: (event, data) => events.push(data?.source ? `${event}:${String(data.source)}` : event),
    shortcut: {
      register(accelerator, callback) {
        registered.set(accelerator, callback);
        return true;
      },
      unregister: (accelerator) => void registered.delete(accelerator),
    },
  });
  try {
    expect(registered.size).toBe(0);
    expect(control.inputStatus().shortcutUnavailable).toBe(false);
    const socket = await connectProxy(control.mcpProxy);
    await until(() => registered.has(STOP_INPUT_ACCELERATOR));
    expect(control.inputStatus().shortcutUnavailable).toBe(false);
    control.gate.cancelSession("other-session");
    registered.get(STOP_INPUT_ACCELERATOR)!();
    // Every Session is held, not only one: nothing is cancelled or cleared.
    expect(control.inputStatus()).toMatchObject({ stopped: true, shortcutUnavailable: false });
    expect(control.gate.snapshot().cancelledSessions).toEqual(["other-session"]);
    expect(events).toContain("computer_input_stopped:shortcut");
    socket.destroy();
    await until(() => registered.size === 0);
    // The hold outlives the connection; only an explicit resume lifts it.
    expect(control.gate.status().stopped).toBe(true);
  } finally {
    await control.close();
  }
});

test("a refused stop shortcut is logged, reported in the input status and retried", async () => {
  let accept = false;
  let attempts = 0;
  const unregistered: string[] = [];
  const events: string[] = [];
  const control = await createComputerUseControl({
    appPath: "/fixture",
    executablePath: process.execPath,
    log: (event) => events.push(event),
    shortcut: {
      register() {
        attempts++;
        return accept;
      },
      unregister: (accelerator) => void unregistered.push(accelerator),
    },
  });
  try {
    const first = await connectProxy(control.mcpProxy);
    await until(() => attempts === 1);
    expect(control.inputStatus()).toMatchObject({ stopped: false, shortcutUnavailable: true });
    expect(events.filter((event) => event === "computer_input_shortcut_unavailable")).toHaveLength(
      1,
    );
    // The on-screen Stop still works without the shortcut.
    control.stopInput("settings");
    expect(control.inputStatus().stopped).toBe(true);
    control.resumeInput("settings");
    // The next connection change tries again; success clears the warning.
    accept = true;
    const second = await connectProxy(control.mcpProxy);
    await until(() => attempts === 2);
    expect(control.inputStatus().shortcutUnavailable).toBe(false);
    first.destroy();
    second.destroy();
    await until(() => unregistered.length === 1);
    expect(control.inputStatus().shortcutUnavailable).toBe(false);
  } finally {
    await control.close();
  }
});

test("an unpackaged acceptance run can keep the stop shortcut off the real keyboard", () => {
  const native = {
    calls: [] as string[],
    register(accelerator: string) {
      native.calls.push(`register ${accelerator}`);
      return true;
    },
    unregister(accelerator: string) {
      native.calls.push(`unregister ${accelerator}`);
    },
  };
  const hooks: { [STOP_SHORTCUT_HOOK]?: () => void } = {};
  const env: NodeJS.ProcessEnv = { [STOP_SHORTCUT_OVERRIDE_ENV]: "virtual" };
  const binding = stopShortcutBinding({ native, env, isPackaged: false, hooks });
  let fired = 0;
  expect(binding.register(STOP_INPUT_ACCELERATOR, () => fired++)).toBe(true);
  hooks[STOP_SHORTCUT_HOOK]!();
  expect(fired).toBe(1);
  binding.unregister(STOP_INPUT_ACCELERATOR);
  expect(hooks[STOP_SHORTCUT_HOOK]).toBeUndefined();
  // Read per registration, so one run can cover both outcomes.
  env[STOP_SHORTCUT_OVERRIDE_ENV] = "unavailable";
  expect(binding.register(STOP_INPUT_ACCELERATOR, () => fired++)).toBe(false);
  expect(hooks[STOP_SHORTCUT_HOOK]).toBeUndefined();
  expect(native.calls).toEqual([]);

  // Unset, or in a packaged app whatever the variable says, the real one is used.
  for (const real of [
    stopShortcutBinding({ native, env: {}, isPackaged: false, hooks }),
    stopShortcutBinding({ native, env, isPackaged: true, hooks }),
  ]) {
    expect(real.register(STOP_INPUT_ACCELERATOR, () => {})).toBe(true);
    real.unregister(STOP_INPUT_ACCELERATOR);
  }
  expect(native.calls).toEqual([
    `register ${STOP_INPUT_ACCELERATOR}`,
    `unregister ${STOP_INPUT_ACCELERATOR}`,
    `register ${STOP_INPUT_ACCELERATOR}`,
    `unregister ${STOP_INPUT_ACCELERATOR}`,
  ]);
  expect(hooks[STOP_SHORTCUT_HOOK]).toBeUndefined();
});
