import { describe, test, expect } from "bun:test";
import { EngineRuntime, type EngineRuntimeOptions } from "./runtime.js";
import { ModelPool } from "../llm/model-pool.js";
import { defaultSandboxConfig } from "../tool-system/sandbox/index.js";

// TODO §3.3 — resolveSandboxBackend must not re-resolve every turn. The
// capability probe (seatbelt/bwrap detection) and the auto-downgrade warning
// should fire at most once per (mode, cwd). EngineRuntime.resolveSandbox caches
// by that key; these tests pin the caching contract (same key → same promise,
// different key → fresh; rejections are not cached).

// resolveSandbox only reads/writes its own cache — it never touches the other
// runtime deps — so minimal stubs are enough to construct the runtime.
function makeRuntime(): EngineRuntime {
  const opts = {
    modelPool: {},
    toolRegistry: {},
    settings: {},
    mcpPool: { disconnectAll: async () => {} },
    costTracker: {},
  } as unknown as EngineRuntimeOptions;
  return new EngineRuntime(opts);
}

describe("EngineRuntime.resolveSandbox caching", () => {
  test("same (mode, cwd) returns the SAME cached promise (no re-resolve)", async () => {
    const rt = makeRuntime();
    const cfg = defaultSandboxConfig("off");
    const p1 = rt.resolveSandbox(cfg, "/proj");
    const p2 = rt.resolveSandbox(cfg, "/proj");
    expect(p1).toBe(p2); // identity → resolved exactly once
    expect((await p1).name).toBe("off");
  });

  test("different cwd → different cache entry", async () => {
    const rt = makeRuntime();
    const cfg = defaultSandboxConfig("off");
    const a = rt.resolveSandbox(cfg, "/proj-a");
    const b = rt.resolveSandbox(cfg, "/proj-b");
    expect(a).not.toBe(b);
  });

  test("different mode → different cache entry", async () => {
    const rt = makeRuntime();
    const a = rt.resolveSandbox(defaultSandboxConfig("off"), "/proj");
    // "auto" on a host without a backend resolves to off too, but it's a
    // distinct cache key, so a distinct promise.
    const b = rt.resolveSandbox(defaultSandboxConfig("auto"), "/proj");
    expect(a).not.toBe(b);
  });

  test("a rejected explicit-mode probe is NOT cached (retryable after fix)", async () => {
    const rt = makeRuntime();
    // Pick an explicit mode unavailable on at least one platform so the probe
    // rejects. On macOS, bwrap is unavailable → throws; on Linux, seatbelt is.
    const badMode = process.platform === "darwin" ? "bwrap" : "seatbelt";
    const cfg = { ...defaultSandboxConfig(badMode as "bwrap" | "seatbelt") };
    const first = rt.resolveSandbox(cfg, "/proj");
    await expect(first).rejects.toThrow();
    // After the rejection settles, the next call must be a FRESH promise (the
    // failed one was evicted), not the cached rejection.
    const second = rt.resolveSandbox(cfg, "/proj");
    expect(second).not.toBe(first);
  });
});

describe("EngineRuntime model pool ownership", () => {
  test("clearModels clears the shared model pool", () => {
    const modelPool = new ModelPool();
    modelPool.register({ key: "ds", provider: "openai", model: "deepseek-v4-flash" });
    const rt = new EngineRuntime({
      modelPool,
      toolRegistry: {} as never,
      settings: { load: () => ({}) } as never,
      mcpPool: { disconnectAll: async () => {} } as never,
      costTracker: {} as never,
    });

    rt.clearModels();
    expect(modelPool.list()).toEqual([]);
  });

  test("reloads the shared model pool from fresh settings", () => {
    let model = "deepseek-v4-flash";
    const modelPool = new ModelPool();
    const rt = new EngineRuntime({
      modelPool,
      toolRegistry: {} as never,
      settings: {
        load: () => ({
          credentials: [
            {
              id: "ds-key",
              catalogId: "deepseek",
              apiKey: "sk-test",
              baseUrl: "https://api.deepseek.com/v1",
            },
          ],
          modelConnections: [
            { id: "ds", catalogId: "deepseek", tag: "text", model, credentialId: "ds-key" },
          ],
          defaults: { text: "ds" },
        }),
      } as never,
      mcpPool: { disconnectAll: async () => {} } as never,
      costTracker: {} as never,
    });

    rt.reloadModelsFromSettings();
    expect(modelPool.get("ds")?.model).toBe("deepseek-v4-flash");

    model = "deepseek-v4-pro";
    rt.reloadModelsFromSettings();
    expect(modelPool.get("ds")?.model).toBe("deepseek-v4-pro");
  });

  test("reloadModelsFromSettings clears stale live models when no connections remain", () => {
    const modelPool = new ModelPool();
    modelPool.register({ key: "old", provider: "openai", model: "old-model" });
    const rt = new EngineRuntime({
      modelPool,
      toolRegistry: {} as never,
      settings: { load: () => ({ modelConnections: [], credentials: [] }) } as never,
      mcpPool: { disconnectAll: async () => {} } as never,
      costTracker: {} as never,
    });

    rt.reloadModelsFromSettings();

    expect(modelPool.list()).toEqual([]);
  });
});
