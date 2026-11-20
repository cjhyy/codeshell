import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createComputerUseControl,
  STOP_INPUT_ACCELERATOR,
  STOP_SHORTCUT_HOOK,
  STOP_SHORTCUT_OVERRIDE_ENV,
  stopShortcutBinding,
} from "./computer-use-control";
import {
  createStopShortcutLock,
  processStartedAt,
  stopShortcutLockFile,
  stopShortcutOwnerAlive,
} from "./stop-shortcut-lock";

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

// --- One stop shortcut per user: the cross-instance owner file.

const lockDir = () => mkdtemp(join(tmpdir(), "stop-shortcut-lock-"));
type Owner = { pid: number; startedAt: number };

test("only one live owner holds the stop shortcut; a dead or reused owner is recovered", async () => {
  const dir = await lockDir();
  try {
    const file = join(dir, "stop-shortcut.owner.json");
    const live = new Set<string>();
    const isAlive = async (owner: Owner) => live.has(`${owner.pid}@${owner.startedAt}`);
    const owner = (pid: number, startedAt: number) => {
      live.add(`${pid}@${startedAt}`);
      return createStopShortcutLock({ file, pid, startedAt, isAlive });
    };
    const first = owner(101, 1_000);
    const second = owner(202, 2_000);
    expect(await first.acquire()).toBe(true);
    // Re-acquiring what one already holds is not a conflict.
    expect(await first.acquire()).toBe(true);
    expect(await second.acquire()).toBe(false);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ pid: 101, startedAt: 1_000 });
    // A release by a non-owner leaves the owner's claim alone.
    await second.release();
    expect(await second.acquire()).toBe(false);
    await first.release();
    expect(await second.acquire()).toBe(true);

    // The owner died without releasing: its claim is stale.
    live.delete("202@2000");
    const third = owner(303, 3_000);
    expect(await third.acquire()).toBe(true);
    // Same pid, different start time: the pid now belongs to another process.
    live.delete("303@3000");
    live.add("303@9999");
    const fourth = owner(404, 4_000);
    expect(await fourth.acquire()).toBe(true);
    // An unreadable claim is not an owner either.
    await writeFile(file, "{not json");
    const fifth = owner(505, 5_000);
    expect(await fifth.acquire()).toBe(true);
    // The synchronous release (process exit) also removes only its own claim.
    fourth.releaseSync();
    expect(existsSync(file)).toBe(true);
    fifth.releaseSync();
    expect(existsSync(file)).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("simulated instances racing for the stop shortcut get exactly one owner", async () => {
  const dir = await lockDir();
  try {
    const file = join(dir, "stop-shortcut.owner.json");
    const owners = Array.from({ length: 8 }, (_, index) =>
      createStopShortcutLock({
        file,
        pid: 1_000 + index,
        startedAt: index,
        isAlive: async () => true,
      }),
    );
    const won = await Promise.all(owners.map((owner) => owner.acquire()));
    expect(won.filter(Boolean)).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the default liveness check knows this process, a reused pid and a finished one", async () => {
  const self = { pid: process.pid, startedAt: processStartedAt() };
  expect(await stopShortcutOwnerAlive(self)).toBe(true);
  expect(await stopShortcutOwnerAlive({ ...self, startedAt: self.startedAt - 3_600_000 })).toBe(
    false,
  );
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  expect(await stopShortcutOwnerAlive({ pid: child.pid!, startedAt: Date.now() })).toBe(false);
});

test("an instance whose shortcut is held elsewhere reports it unavailable, and releases on disconnect and close", async () => {
  const dir = await lockDir();
  try {
    const file = join(dir, "stop-shortcut.owner.json");
    const live = new Set(["1@1", "2@2"]);
    const isAlive = async (owner: Owner) => live.has(`${owner.pid}@${owner.startedAt}`);
    const other = createStopShortcutLock({ file, pid: 1, startedAt: 1, isAlive });
    expect(await other.acquire()).toBe(true);
    const native = { registered: 0, unregistered: 0 };
    const events: string[] = [];
    const control = await createComputerUseControl({
      appPath: "/fixture",
      executablePath: process.execPath,
      log: (event) => events.push(event),
      shortcut: stopShortcutBinding({
        native: {
          register: () => (native.registered++, true),
          unregister: () => void native.unregistered++,
        },
        env: {},
        isPackaged: true,
        lock: () => createStopShortcutLock({ file, pid: 2, startedAt: 2, isAlive }),
      }),
    });
    try {
      const first = await connectProxy(control.mcpProxy);
      await until(() => control.inputStatus().shortcutUnavailable);
      // The other instance keeps the key: this one never even asks macOS.
      expect(native.registered).toBe(0);
      expect(events).toContain("computer_input_shortcut_unavailable");
      first.destroy();
      await until(() => !control.inputStatus().shortcutUnavailable);

      // Once the other owner is gone, the next connection takes it over.
      live.delete("1@1");
      const second = await connectProxy(control.mcpProxy);
      await until(() => native.registered === 1);
      expect(control.inputStatus().shortcutUnavailable).toBe(false);
      expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ pid: 2 });
      second.destroy();
      await until(() => native.unregistered === 1 && !existsSync(file));

      const third = await connectProxy(control.mcpProxy);
      await until(() => native.registered === 2 && existsSync(file));
      third.destroy();
      await control.close();
      expect(existsSync(file)).toBe(false);
    } finally {
      await control.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("acceptance runs coordinate in their own namespace and a refused mode takes no lock", async () => {
  const namespaces: string[] = [];
  const hooks: { [STOP_SHORTCUT_HOOK]?: () => void } = {};
  const env: NodeJS.ProcessEnv = { [STOP_SHORTCUT_OVERRIDE_ENV]: "virtual" };
  const binding = stopShortcutBinding({
    native: { register: () => true, unregister() {} },
    env,
    isPackaged: false,
    hooks,
    lock: (namespace) => {
      namespaces.push(namespace);
      return { acquire: async () => true, release: async () => {}, releaseSync() {} };
    },
  });
  expect(await binding.register(STOP_INPUT_ACCELERATOR, () => {})).toBe(true);
  expect(typeof hooks[STOP_SHORTCUT_HOOK]).toBe("function");
  await binding.unregister(STOP_INPUT_ACCELERATOR);
  expect(hooks[STOP_SHORTCUT_HOOK]).toBeUndefined();
  env[STOP_SHORTCUT_OVERRIDE_ENV] = "unavailable";
  expect(await binding.register(STOP_INPUT_ACCELERATOR, () => {})).toBe(false);
  expect(namespaces).toEqual(["virtual"]);
  expect(stopShortcutLockFile("virtual", "/run")).not.toBe(stopShortcutLockFile("native", "/run"));
});
