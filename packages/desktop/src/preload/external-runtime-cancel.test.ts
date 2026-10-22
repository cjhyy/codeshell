import { describe, expect, test } from "bun:test";
import { cancelSessionRun } from "./external-runtime-session-state";

function fakeMain(owned: Set<string>) {
  const calls: unknown[][] = [];
  return {
    calls,
    ipc: {
      async invoke(channel: string, ...args: unknown[]) {
        calls.push([channel, ...args]);
        return { handled: owned.has(String(args[0])) };
      },
    },
  };
}

describe("Stop routing after a renderer reload", () => {
  test("a session Main owns is interrupted even though preload forgot it", async () => {
    // Reload empties preload memory; Main still owns the live Codex runtime.
    const main = fakeMain(new Set(["sess-codex"]));
    const native: Array<string | undefined> = [];
    await cancelSessionRun(main.ipc, async (id) => native.push(id), "sess-codex", {
      keepGoal: true,
    });
    expect(main.calls).toEqual([
      ["externalRuntime:interrupt", "sess-codex", { keepGoal: true, ifOwned: true }],
    ]);
    expect(native).toEqual([]);
  });

  test("a native session falls through to the worker cancel", async () => {
    const main = fakeMain(new Set(["sess-codex"]));
    const native: Array<string | undefined> = [];
    await cancelSessionRun(main.ipc, async (id) => native.push(id), "sess-native");
    expect(native).toEqual(["sess-native"]);
  });

  test("a legacy call without a session id goes straight to the worker", async () => {
    const main = fakeMain(new Set());
    const native: Array<string | undefined> = [];
    await cancelSessionRun(main.ipc, async (id) => native.push(id), undefined);
    expect(main.calls).toEqual([]);
    expect(native).toEqual([undefined]);
  });
});
