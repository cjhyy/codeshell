import { describe, it, expect } from "bun:test";
import { Engine } from "../engine.js";
import { createLLMClient } from "../../llm/client-factory.js";
import { ModelPool } from "../../llm/model-pool.js";

/**
 * resolveAuxClient must decide "is the aux model the same as MY active model?"
 * against THIS engine's own per-session config.llm.model — not the SHARED
 * ModelPool's activeKey, which any other session's switchModel can mutate
 * concurrently, and NOT a separately-tracked active-key field (which used to be
 * left `undefined` for desktop worker sessions built with a shared runtime,
 * silently defeating the de-dup).
 *
 * KEY REGRESSION: these engines are built the way the desktop worker builds
 * them — WITH a `runtime` (so the ctor SKIPS populateModelPoolFromSettings and
 * the engine never explicitly switchModel()s). The old code compared against an
 * `activeModelKey` field that stayed undefined on this path, so a matching aux
 * model wrongly built a second client. The fix compares entry.model against
 * config.llm.model, which is always set for a real session.
 */
function buildWorkerEngine(activeModel: string): { engine: Engine; pool: ModelPool } {
  // Shared pool — register two models. Engines built WITH a runtime adopt this
  // pool and (critically) skip populateModelPoolFromSettings + never switchModel.
  const pool = new ModelPool();
  pool.register({ key: "A-key", provider: "openai", model: "model-a", apiKey: "x", baseUrl: "http://localhost" });
  pool.register({ key: "B-key", provider: "openai", model: "model-b", apiKey: "x", baseUrl: "http://localhost" });

  const engine = new Engine({
    llm: { provider: "openai", model: activeModel, apiKey: "x", baseUrl: "http://localhost" },
    cwd: process.cwd(),
    // Minimal shared runtime: only modelPool is read by the paths under test.
    runtime: { modelPool: pool } as any,
  } as any);
  return { engine, pool };
}

/** Stub the engine's settings reader so we control the aux model key deterministically. */
function stubAuxKey(engine: Engine, auxText: string | undefined): void {
  (engine as any).getSettingsManager = () => ({
    invalidate() {},
    get() {
      return { defaults: { auxText } };
    },
  });
}

describe("resolveAuxClient de-dups against config.llm.model (runtime/worker path)", () => {
  it("returns the fallback when aux model's entry == the engine's active model (no switchModel)", async () => {
    // Worker session: active model is model-a, built with a runtime, NEVER
    // switchModel'd. auxModelKey="A-key" whose entry.model === "model-a".
    const { engine } = buildWorkerEngine("model-a");
    stubAuxKey(engine, "A-key");
    const fallback = await createLLMClient(
      { provider: "openai", model: "model-a", apiKey: "x", baseUrl: "http://localhost" },
    );
    const result = await (engine as any).resolveAuxClient(fallback);
    // de-dup must work even though no explicit switchModel ever happened.
    expect(result).toBe(fallback);
  });

  it("builds a separate client when aux model's entry differs from the active model", async () => {
    const { engine } = buildWorkerEngine("model-a");
    stubAuxKey(engine, "B-key"); // entry.model === "model-b" ≠ "model-a"
    const fallback = await createLLMClient(
      { provider: "openai", model: "model-a", apiKey: "x", baseUrl: "http://localhost" },
    );
    const result = await (engine as any).resolveAuxClient(fallback);
    expect(result).not.toBe(fallback);
  });

  // CRITICAL regression: another session mutates the SHARED pool's activeKey to
  // B after this engine adopted A. Our aux decision must still see A (our own
  // config.llm.model), so auxModelKey="A-key" must STILL return fallback.
  it("ignores the shared pool's activeKey being mutated by another session", async () => {
    const { engine, pool } = buildWorkerEngine("model-a");
    // Simulate a different session switching the SHARED pool to B directly.
    pool.switch("B-key");
    expect(pool.getActiveKey()).toBe("B-key");

    stubAuxKey(engine, "A-key");
    const fallback = await createLLMClient(
      { provider: "openai", model: "model-a", apiKey: "x", baseUrl: "http://localhost" },
    );
    const result = await (engine as any).resolveAuxClient(fallback);
    // Engine's OWN active model (config.llm.model) is still "model-a" → aux ==
    // active → fallback.
    expect(result).toBe(fallback);
  });
});

/**
 * EDGE CASE: two DISTINCT pool keys can share the same `model` NAME yet differ
 * in per-key config (reasoning / maxOutputTokens / baseUrl). De-duping on the
 * model NAME alone would wrongly short-circuit to the primary's client and run
 * aux work on the wrong config. resolveAuxClient must compare FULL LLM IDENTITY.
 */
describe("resolveAuxClient de-dups on full LLM identity, not just model name", () => {
  function buildEngineWith(activeLlm: any, pool: ModelPool): Engine {
    return new Engine({
      llm: activeLlm,
      cwd: process.cwd(),
      runtime: { modelPool: pool } as any,
    } as any);
  }

  it("builds a separate aux client when keys share a model name but differ in maxOutputTokens", async () => {
    const pool = new ModelPool();
    // Active key: model "shared", default tokens. Aux key: SAME model name,
    // different maxOutputTokens → distinct identity.
    pool.register({ key: "active", provider: "openai", model: "shared", apiKey: "x", baseUrl: "http://localhost", maxOutputTokens: 1000 });
    pool.register({ key: "aux", provider: "openai", model: "shared", apiKey: "x", baseUrl: "http://localhost", maxOutputTokens: 4000 });

    const engine = buildEngineWith(
      { provider: "openai", model: "shared", apiKey: "x", baseUrl: "http://localhost", maxTokens: 1000 },
      pool,
    );
    stubAuxKey(engine, "aux");
    const fallback = await createLLMClient(
      { provider: "openai", model: "shared", apiKey: "x", baseUrl: "http://localhost", maxTokens: 1000 },
    );
    const result = await (engine as any).resolveAuxClient(fallback);
    // model NAMEs match but identities differ → must NOT short-circuit.
    expect(result).not.toBe(fallback);
  });

  it("builds a separate aux client when keys share a model name but differ in baseUrl", async () => {
    const pool = new ModelPool();
    pool.register({ key: "active", provider: "openai", model: "shared", apiKey: "x", baseUrl: "http://primary" });
    pool.register({ key: "aux", provider: "openai", model: "shared", apiKey: "x", baseUrl: "http://aux" });

    const engine = buildEngineWith(
      { provider: "openai", model: "shared", apiKey: "x", baseUrl: "http://primary" },
      pool,
    );
    stubAuxKey(engine, "aux");
    const fallback = await createLLMClient(
      { provider: "openai", model: "shared", apiKey: "x", baseUrl: "http://primary" },
    );
    const result = await (engine as any).resolveAuxClient(fallback);
    expect(result).not.toBe(fallback);
  });

  it("returns the fallback when the aux key resolves to an IDENTICAL config", async () => {
    const pool = new ModelPool();
    pool.register({ key: "active", provider: "openai", model: "shared", apiKey: "x", baseUrl: "http://localhost", maxOutputTokens: 2000 });
    // Distinct KEY but every identity-bearing field matches the active llm.
    pool.register({ key: "aux", provider: "openai", model: "shared", apiKey: "x", baseUrl: "http://localhost", maxOutputTokens: 2000 });

    const engine = buildEngineWith(
      { provider: "openai", model: "shared", apiKey: "x", baseUrl: "http://localhost", maxTokens: 2000 },
      pool,
    );
    stubAuxKey(engine, "aux");
    const fallback = await createLLMClient(
      { provider: "openai", model: "shared", apiKey: "x", baseUrl: "http://localhost", maxTokens: 2000 },
    );
    const result = await (engine as any).resolveAuxClient(fallback);
    // identical identity → genuinely the same client → fallback.
    expect(result).toBe(fallback);
  });
});
