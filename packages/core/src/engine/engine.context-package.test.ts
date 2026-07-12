import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse } from "../types.js";
import { CONTEXT_PACKAGE_MAX_OUTPUT_TOKENS, estimateTokens } from "../context/compaction.js";
import { ModelPool } from "../llm/model-pool.js";
import { ToolRegistry } from "../tool-system/registry.js";
import { Engine } from "./engine.js";

const provider = "fake-context-package";
const calls: Array<{ model: string; options: CreateMessageOptions }> = [];

class ContextPackageClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    calls.push({ model: this.model, options });
    const response = {
      text: String(options.messages[0]?.content).includes("FORCE_EMPTY")
        ? ""
        : `packaged by ${this.model}`,
      toolCalls: [],
      stopReason: "stop" as const,
      usage: { promptTokens: 20, completionTokens: 1500, totalTokens: 1520 },
    };
    this.recordUsage(response.usage, options);
    return response;
  }
}

registerProvider(provider, ContextPackageClient);

describe("Engine.summarizeContextPackage", () => {
  const dirs: string[] = [];
  afterEach(() => {
    calls.length = 0;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("routes context packaging to defaults.auxText and requests a 1,500-2,000 token result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "context-package-"));
    dirs.push(dir);
    const engine = new Engine({
      llm: { provider, model: "primary", apiKey: "test" } as never,
      cwd: dir,
      sessionStorageDir: join(dir, "sessions"),
    });
    (engine as any).modelPool.register({
      key: "aux-key",
      provider,
      model: "auxiliary",
      apiKey: "test",
    });
    (engine as any).getSettingsManager = () => ({
      invalidate() {},
      get: () => ({ defaults: { auxText: "aux-key" } }),
    });

    const result = await engine.summarizeContextPackage([
      { role: "user", content: "selected request" },
      { role: "assistant", content: "selected answer" },
    ]);

    expect(result.summary).toBe("packaged by auxiliary");
    expect(result.estimatedTokens).toBeGreaterThan(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe("auxiliary");
    expect(calls[0]?.options.maxTokens).toBeGreaterThanOrEqual(1_500);
    expect(calls[0]?.options.maxTokens).toBeLessThanOrEqual(2_000);
    expect(calls[0]?.options.tools).toEqual([]);
    expect(calls[0]?.options.reasoning).toEqual({ mode: "off" });
    expect(String(calls[0]?.options.messages[0]?.content)).toContain("1. **Primary Request**");
  });

  it("restores a cold source model without resetting its persisted usage", () => {
    const dir = mkdtempSync(join(tmpdir(), "context-package-source-model-"));
    dirs.push(dir);
    const engine = new Engine({
      llm: { provider, model: "global-default", apiKey: "test" } as never,
      cwd: dir,
      sessionStorageDir: join(dir, "sessions"),
    });
    engine.getModelPool().register({
      key: "source-key",
      provider,
      model: "source-model",
      apiKey: "test",
      maxContextTokens: 64_000,
    });
    const source = engine
      .getSessionManager()
      .create(dir, "source-model", provider, "source-model-session");
    source.state.tokenUsage = { promptTokens: 7, completionTokens: 3, totalTokens: 10 };
    engine.getSessionManager().saveState(source.state);

    engine.restoreSessionModel("source-model-session");

    expect(engine.getConfig().llm.model).toBe("source-model");
    expect(engine.getSessionManager().resume("source-model-session").state.tokenUsage).toEqual({
      promptTokens: 7,
      completionTokens: 3,
      totalTokens: 10,
    });
  });

  it("restores a cold source model without changing the shared pool or another Engine", () => {
    const dir = mkdtempSync(join(tmpdir(), "context-package-shared-model-"));
    dirs.push(dir);
    const modelPool = new ModelPool(
      [
        {
          key: "global-key",
          provider,
          model: "global-model",
          apiKey: "test",
          maxContextTokens: 128_000,
        },
        {
          key: "source-key",
          provider,
          model: "source-model",
          apiKey: "test",
          maxContextTokens: 64_000,
        },
      ],
      "global-key",
    );
    const runtime = {
      modelPool,
      toolRegistry: new ToolRegistry({ builtinTools: [] }),
    } as never;
    const sourceEngine = new Engine({
      llm: modelPool.toLLMConfig(modelPool.get("global-key")!),
      cwd: dir,
      sessionStorageDir: join(dir, "source-sessions"),
      runtime,
    });
    const otherEngine = new Engine({
      llm: modelPool.toLLMConfig(modelPool.get("global-key")!),
      cwd: dir,
      sessionStorageDir: join(dir, "other-sessions"),
      runtime,
    });
    sourceEngine.getSessionManager().create(dir, "source-model", provider, "cold-source-session");

    sourceEngine.restoreSessionModel("cold-source-session");

    expect(sourceEngine.getConfig().llm.model).toBe("source-model");
    expect(sourceEngine.maxContextTokens).toBe(64_000);
    expect(modelPool.getActiveKey()).toBe("global-key");
    expect(otherEngine.getConfig().llm.model).toBe("global-model");
    expect(otherEngine.maxContextTokens).toBe(128_000);
  });

  it("maps complete rounds and rolling-merges an oversized selection without dropping the tail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "context-package-chunks-"));
    dirs.push(dir);
    const engine = new Engine({
      llm: { provider, model: "primary", apiKey: "test" } as never,
      cwd: dir,
      sessionStorageDir: join(dir, "sessions"),
      maxContextTokens: 6_000,
    });
    (engine as any).modelPool.register({
      key: "aux-key",
      provider,
      model: "auxiliary",
      apiKey: "test",
    });
    (engine as any).getSettingsManager = () => ({
      invalidate() {},
      get: () => ({ defaults: { auxText: "aux-key" } }),
    });
    const messages = Array.from({ length: 8 }, (_, index) => [
      { role: "user" as const, content: `round-${index}-user ${"x".repeat(2_500)}` },
      { role: "assistant" as const, content: `round-${index}-assistant` },
    ]).flat();

    await engine.summarizeContextPackage(messages);

    expect(calls.length).toBeGreaterThan(1);
    const prompts = calls.map((call) => String(call.options.messages[0]?.content));
    expect(prompts.join("\n")).toContain("round-0-user");
    expect(prompts.join("\n")).toContain("round-7-assistant");
    expect(prompts.at(-1)).toContain("Prior summary");
  });

  it("uses the aux model context window and second-level chunks a single oversized API round", async () => {
    const dir = mkdtempSync(join(tmpdir(), "context-package-aux-window-"));
    dirs.push(dir);
    const engine = new Engine({
      llm: { provider, model: "primary", apiKey: "test" } as never,
      cwd: dir,
      sessionStorageDir: join(dir, "sessions"),
      maxContextTokens: 200_000,
    });
    (engine as any).modelPool.register({
      key: "aux-key",
      provider,
      model: "auxiliary",
      apiKey: "test",
      maxContextTokens: 32_000,
    });
    (engine as any).getSettingsManager = () => ({
      invalidate() {},
      get: () => ({ defaults: { auxText: "aux-key" } }),
    });
    const tail = "SINGLE_ROUND_TAIL";
    const messages = [
      { role: "user" as const, content: `one-round ${"x".repeat(150_000)}${tail}` },
      { role: "assistant" as const, content: "done" },
    ];

    await engine.summarizeContextPackage(messages);

    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) {
      const requestTokens = estimateTokens([
        { role: "system", content: call.options.systemPrompt ?? "" },
        ...call.options.messages,
      ]);
      expect(requestTokens + CONTEXT_PACKAGE_MAX_OUTPUT_TOKENS).toBeLessThanOrEqual(32_000);
    }
    expect(calls.map((call) => String(call.options.messages[0]?.content)).join("\n")).toContain(
      tail,
    );
  });

  it("rejects an image-only selection before calling the aux model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "context-package-image-only-"));
    dirs.push(dir);
    const engine = new Engine({
      llm: { provider, model: "primary", apiKey: "test" } as never,
      cwd: dir,
      sessionStorageDir: join(dir, "sessions"),
    });

    await expect(
      engine.summarizeContextPackage([
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "pixels" },
            },
          ],
        },
      ]),
    ).rejects.toThrow(/image-only|summarizable/i);
    expect(calls).toHaveLength(0);
  });

  it("records billed aux usage without changing the source lifecycle status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "context-package-usage-"));
    dirs.push(dir);
    const engine = new Engine({
      llm: { provider, model: "primary", apiKey: "test" } as never,
      cwd: dir,
      sessionStorageDir: join(dir, "sessions"),
    });
    (engine as any).modelPool.register({
      key: "aux-key",
      provider,
      model: "auxiliary",
      apiKey: "test",
    });
    (engine as any).getSettingsManager = () => ({
      invalidate() {},
      get: () => ({ defaults: { auxText: "aux-key" } }),
    });
    const source = engine.getSessionManager().create(dir, "primary", provider, "usage-source");
    source.state.status = "completed";
    engine.getSessionManager().saveState(source.state);

    await engine.summarizeContextPackage(
      [{ role: "user", content: "selected" }],
      undefined,
      "usage-source",
    );

    const state = JSON.parse(
      readFileSync(join(dir, "sessions", "usage-source", "state.json"), "utf-8"),
    );
    expect(state.status).toBe("completed");
    expect(state.cumulativePromptTokens).toBe(20);
    expect(state.tokenUsage).toEqual({
      promptTokens: 20,
      completionTokens: 1500,
      totalTokens: 1520,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it("persists billed usage even when the aux model returns an unusable empty summary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "context-package-empty-usage-"));
    dirs.push(dir);
    const engine = new Engine({
      llm: { provider, model: "primary", apiKey: "test" } as never,
      cwd: dir,
      sessionStorageDir: join(dir, "sessions"),
    });
    engine.getSessionManager().create(dir, "primary", provider, "empty-usage-source");

    await expect(
      engine.summarizeContextPackage(
        [{ role: "user", content: "FORCE_EMPTY" }],
        undefined,
        "empty-usage-source",
      ),
    ).rejects.toThrow(/empty/i);

    const state = JSON.parse(
      readFileSync(join(dir, "sessions", "empty-usage-source", "state.json"), "utf-8"),
    );
    expect(state.tokenUsage.totalTokens).toBe(1520);
    expect(state.cumulativePromptTokens).toBe(20);
  });
});
