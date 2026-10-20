import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "@cjhyy/code-shell-core";
import { applyRunLlmOverrides } from "./run-llm-config.js";

describe("applyRunLlmOverrides", () => {
  let dir: string | undefined;
  let engine: Engine | undefined;

  afterEach(async () => {
    await engine?.dispose();
    engine = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("explicit flags win over the seed Engine's catalog default", () => {
    dir = mkdtempSync(join(tmpdir(), "cs-run-llm-"));
    mkdirSync(join(dir, ".code-shell"));
    writeFileSync(
      join(dir, ".code-shell", "settings.json"),
      JSON.stringify({
        credentials: [
          {
            id: "saved-key",
            catalogId: "openai",
            apiKey: "saved-api-key",
            baseUrl: "https://saved.example.invalid/v1",
          },
        ],
        modelConnections: [
          {
            id: "saved",
            catalogId: "openai",
            tag: "text",
            model: "gpt-4o",
            credentialId: "saved-key",
          },
        ],
        defaults: { text: "saved" },
      }),
    );
    // The seed re-resolves the catalog default in its constructor, whatever llm it was given.
    engine = new Engine({
      cwd: dir,
      settingsScope: "full",
      headless: true,
      sessionStorageDir: join(dir, "sessions"),
      llm: { provider: "openai", model: "bootstrap" },
    });
    const seed = engine.getConfig().llm;
    expect(seed.model).toBe("gpt-4o");

    const llm = applyRunLlmOverrides(seed, {
      model: "flag-model",
      baseUrl: "https://flag.example.invalid/v1",
      apiKey: "flag-api-key",
    });

    expect(llm).toMatchObject({
      provider: "openai",
      model: "flag-model",
      baseUrl: "https://flag.example.invalid/v1",
      apiKey: "flag-api-key",
    });
    // A pool binding would re-resolve the saved connection at the next run boundary.
    expect(llm.modelKey).toBeUndefined();
  });

  test("keeps the resolved connection untouched without flags", () => {
    const resolved = { provider: "openai", model: "gpt-4o", modelKey: "saved", maxTokens: 4096 };
    expect(applyRunLlmOverrides(resolved, {})).toBe(resolved);
  });

  test("a model override drops the saved model's per-model limits", () => {
    const llm = applyRunLlmOverrides(
      {
        provider: "openai",
        model: "gpt-4o",
        modelKey: "saved",
        apiKey: "saved-api-key",
        maxTokens: 4096,
        maxContextTokens: 128_000,
        supportsVision: true,
      },
      { model: "other-model" },
    );
    expect(llm).toEqual({ provider: "openai", model: "other-model", apiKey: "saved-api-key" });
  });

  test("run applies the flags after the seed Engine resolves the catalog", () => {
    const runSource = readFileSync(new URL("./run.ts", import.meta.url), "utf-8");
    expect(runSource).toContain(
      "const resolvedLlmConfig = applyRunLlmOverrides(seedEngine.getConfig().llm, options);",
    );
  });
});
