import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, useState } from "react";
import { ensureMiniDom, renderHook } from "../test-utils/renderHook";
import {
  noteDesktopModelChoice,
  persistedSessionModelKey,
  reconcileModelOverride,
  useSessionModelReconcile,
} from "./useSessionModelReconcile";

describe("persistedSessionModelKey", () => {
  test("names only exact runtime or configured-connection identities", () => {
    expect(persistedSessionModelKey({ provider: "codex", model: "codex/gpt-6-astra" })).toBe(
      "codex/gpt-6-astra",
    );
    expect(persistedSessionModelKey({ provider: "claude-code", model: "sonnet" })).toBe(
      "claude-code/sonnet",
    );
    // Legacy codex keys normalize; a lingering connection id never beats a runtime.
    expect(
      persistedSessionModelKey({
        provider: "codex",
        model: "codex/gpt-5.1",
        modelConnectionId: "conn-a",
      }),
    ).toBe("codex/gpt-5.6-sol");
    expect(persistedSessionModelKey({ provider: "claude-code" })).toBeUndefined();
    expect(persistedSessionModelKey({ model: "codex/legacy" })).toBe("codex/legacy");
    expect(
      persistedSessionModelKey({ provider: "openai", model: "gpt", modelConnectionId: "conn-a" }),
    ).toBe("conn-a");
    // A native label is ambiguous across connections and is not guessed.
    expect(persistedSessionModelKey({ provider: "openai", model: "codex/custom" })).toBeUndefined();
  });
});

describe("reconcileModelOverride", () => {
  test("adopts disk unless the bucket holds an unsent Desktop choice", () => {
    const none = new Map<string, string>();
    expect(reconcileModelOverride({}, "p::s", "codex/x", none)).toEqual({ "p::s": "codex/x" });
    expect(reconcileModelOverride({ "p::s": "old" }, "p::s", "codex/x", none)).toEqual({
      "p::s": "codex/x",
    });
    const same = { "p::s": "codex/x" };
    expect(reconcileModelOverride(same, "p::s", "codex/x", none)).toBe(same);
    const chosen = { "p::s": "conn-b" };
    expect(reconcileModelOverride(chosen, "p::s", "codex/x", new Map([["p::s", "conn-b"]]))).toBe(
      chosen,
    );
    // A later override (e.g. a live phone choice) is no longer the protected one.
    expect(
      reconcileModelOverride(
        { "p::s": "conn-c" },
        "p::s",
        "codex/x",
        new Map([["p::s", "conn-b"]]),
      ),
    ).toEqual({ "p::s": "codex/x" });
  });
});

describe("useSessionModelReconcile", () => {
  let bridgeBefore: PropertyDescriptor | undefined;
  let disk: Record<string, { provider?: string; model?: string; modelConnectionId?: string }>;
  let reads: unknown[];
  const hooks: Array<{ unmount: () => Promise<void> }> = [];

  beforeEach(() => {
    ensureMiniDom();
    reads = [];
    disk = {};
    bridgeBefore = Object.getOwnPropertyDescriptor(window, "codeshell");
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      value: {
        log: mock(() => {}),
        listDiskSessions: async (opts: { sessionId: string }) => {
          reads.push(opts);
          const meta = disk[opts.sessionId];
          return { sessions: meta ? [{ id: opts.sessionId, ...meta }] : [], nextCursor: null };
        },
      },
    });
  });

  afterEach(async () => {
    for (const hook of hooks.splice(0)) await hook.unmount();
    if (bridgeBefore) Object.defineProperty(window, "codeshell", bridgeBefore);
    else Reflect.deleteProperty(window, "codeshell");
  });

  const mount = async (initial: Record<string, string>, bucket: string, sessionId: string) => {
    const hook = await renderHook(() => {
      const [overrides, setOverrides] = useState(initial);
      useSessionModelReconcile(bucket, sessionId, setOverrides);
      return overrides;
    });
    hooks.push(hook);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return hook;
  };

  test("opening a Session corrects a stale pill to the model it actually runs on", async () => {
    disk["s1"] = { provider: "codex", model: "codex/gpt-6-astra" };
    const hook = await mount({ "p::s1": "openrouter-conn" }, "p::s1", "s1");
    expect(reads).toEqual([{ limit: 1, sessionId: "s1" }]);
    expect(hook.result.current).toEqual({ "p::s1": "codex/gpt-6-astra" });
  });

  test("a model the Desktop user just picked for the next turn survives reopening", async () => {
    disk["s2"] = { provider: "codex", model: "codex/gpt-6-astra" };
    noteDesktopModelChoice("p::s2", "conn-next");
    const hook = await mount({ "p::s2": "conn-next" }, "p::s2", "s2");
    expect(hook.result.current).toEqual({ "p::s2": "conn-next" });
  });

  test("an ambiguous native Session keeps the current pill", async () => {
    disk["s3"] = { provider: "openai", model: "gpt" };
    const hook = await mount({ "p::s3": "conn-a" }, "p::s3", "s3");
    expect(hook.result.current).toEqual({ "p::s3": "conn-a" });
  });
});
