import { describe, it, expect } from "bun:test";
import { Engine } from "../engine.js";
import { createLLMClient } from "../../llm/client-factory.js";

/**
 * resolveAuxClient must decide "is the aux model the same as MY active model?"
 * against THIS engine's own active model key — not the SHARED ModelPool's
 * activeKey, which any other session's switchModel can mutate concurrently.
 */
function buildEngine(): Engine {
  const engine = new Engine({
    llm: { provider: "openai", model: "model-a", apiKey: "x", baseUrl: "http://localhost" },
    cwd: process.cwd(),
  } as any);
  // Seed two models on this engine's pool.
  const pool = engine.getModelPool();
  pool.register({ key: "A-key", provider: "openai", model: "model-a", apiKey: "x", baseUrl: "http://localhost" });
  pool.register({ key: "B-key", provider: "openai", model: "model-b", apiKey: "x", baseUrl: "http://localhost" });
  return engine;
}

/** Stub the engine's settings reader so we control auxModelKey deterministically. */
function stubAuxModelKey(engine: Engine, auxModelKey: string | undefined): void {
  (engine as any).getSettingsManager = () => ({
    invalidate() {},
    get() {
      return { auxModelKey };
    },
  });
}

describe("resolveAuxClient uses this engine's own active model key", () => {
  it("returns the fallback when aux model IS the engine's active model", async () => {
    const engine = buildEngine();
    engine.switchModel("A-key");
    stubAuxModelKey(engine, "A-key");
    const fallback = await createLLMClient(
      { provider: "openai", model: "model-a", apiKey: "x", baseUrl: "http://localhost" },
    );
    const result = await (engine as any).resolveAuxClient(fallback);
    expect(result).toBe(fallback);
  });

  it("builds a separate client when aux model differs from the active model", async () => {
    const engine = buildEngine();
    engine.switchModel("A-key");
    stubAuxModelKey(engine, "B-key");
    const fallback = await createLLMClient(
      { provider: "openai", model: "model-a", apiKey: "x", baseUrl: "http://localhost" },
    );
    const result = await (engine as any).resolveAuxClient(fallback);
    expect(result).not.toBe(fallback);
  });

  // CRITICAL regression: another session mutates the SHARED pool's activeKey to
  // B after we adopted A. Our aux decision must still see A (our own key), so
  // auxModelKey="A-key" must STILL return fallback. Before the fix this read
  // pool.getActiveKey() === "B-key", so "A-key" !== "B-key" wrongly built a client.
  it("ignores the shared pool's activeKey being mutated by another session", async () => {
    const engine = buildEngine();
    engine.switchModel("A-key");
    // Simulate a different session switching the SHARED pool to B directly.
    engine.getModelPool().switch("B-key");
    expect(engine.getModelPool().getActiveKey()).toBe("B-key");

    stubAuxModelKey(engine, "A-key");
    const fallback = await createLLMClient(
      { provider: "openai", model: "model-a", apiKey: "x", baseUrl: "http://localhost" },
    );
    const result = await (engine as any).resolveAuxClient(fallback);
    // Engine's OWN active model is still A → aux == active → fallback.
    expect(result).toBe(fallback);
  });
});
