import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  editModelCatalogTool,
  editModelCatalogToolDef,
  setModelCatalogChangedSink,
} from "./edit-model-catalog.js";
import { BUILTIN_CATALOG, getMergedCatalog, userCatalogPath } from "../../model-catalog/index.js";

/**
 * EditModelCatalog writes a user-catalog entry and echoes a structured summary
 * so the user can eyeball every param's options/default against the provider's
 * official docs. Tests pin: schema validation passthrough, the added/updated
 * action word, enum/number/no-presets summary branches, and the error path.
 * HOME is isolated so the write lands in a temp dir, not ~/.code-shell.
 */
describe("EditModelCatalog tool", () => {
  let home: string;
  let prevHome: string | undefined;
  let changed: string[];

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-emc-home-"));
    process.env.HOME = home;
    changed = [];
    setModelCatalogChangedSink(() => changed.push("changed"));
  });
  afterEach(() => {
    setModelCatalogChangedSink(null);
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  const baseEntry = (over: Record<string, unknown> = {}) => ({
    id: "acme",
    tag: "text",
    adapterKind: "openai",
    displayName: "Acme",
    description: "Acme models",
    defaultBaseUrl: "https://api.acme.com/v1",
    ...over,
  });

  test("rejects a missing entry argument", async () => {
    const out = await editModelCatalogTool({});
    expect(out.startsWith("Error:")).toBe(true);
    expect(out).toContain("entry");
  });

  test("rejects a schema-invalid entry (saveCatalogEntry failure → Error:)", async () => {
    // Missing required displayName/description/defaultBaseUrl.
    const out = await editModelCatalogTool({
      entry: { id: "bad", tag: "text", adapterKind: "openai" },
    });
    expect(out.startsWith("Error:")).toBe(true);
    // The write must NOT have happened.
    expect(existsSync(userCatalogPath())).toBe(false);
  });

  test("describes provider identity separately from the wire protocol", () => {
    const schema = editModelCatalogToolDef.inputSchema as {
      properties: Record<string, { description?: string }>;
    };
    const entry = schema.properties.entry;
    expect(entry.description).toContain("openrouter");
    expect(entry.description).toContain("adapterKind is NOT the wire protocol");
    expect(entry.description).toContain("adapterKind='openrouter'");
    expect(entry.description).toContain("protocol='openai-compat'");
  });

  test("describes model upsert as the preferred existing-provider operation", () => {
    expect(editModelCatalogToolDef.description).toContain("operation='upsertModel'");
    const schema = editModelCatalogToolDef.inputSchema as {
      properties: Record<string, { description?: string }>;
    };
    expect(schema.properties.providerId?.description).toContain("openrouter");
    expect(schema.properties.modelPreset?.description).toContain("without hiding");
    expect(schema.properties.entry?.description).toContain("providerId='openrouter'");
  });

  test("adds a model to a built-in provider without hiding its existing models", async () => {
    const builtin = BUILTIN_CATALOG.find((entry) => entry.id === "openrouter")!;
    const out = await editModelCatalogTool({
      operation: "upsertModel",
      providerId: "openrouter",
      modelPreset: {
        value: "moonshotai/kimi-k3",
        label: "Kimi K3",
        maxContextTokens: 1_048_576,
      },
    });

    expect(out).toContain('Added model "moonshotai/kimi-k3" in provider "openrouter"');
    expect(out).toContain("existing provider models preserved");
    const stored = JSON.parse(readFileSync(userCatalogPath(), "utf-8")) as Array<{
      id: string;
      modelPresetsMode?: string;
      modelPresets?: Array<{ value: string }>;
    }>;
    const patch = stored.find((entry) => entry.id === "openrouter")!;
    expect(patch.modelPresetsMode).toBe("merge");
    expect(patch.modelPresets?.map((preset) => preset.value)).toEqual(["moonshotai/kimi-k3"]);

    const merged = getMergedCatalog().find((entry) => entry.id === "openrouter")!;
    expect(merged.modelPresets).toHaveLength((builtin.modelPresets?.length ?? 0) + 1);
    expect(merged.modelPresets?.some((preset) => preset.value === "moonshotai/kimi-k3")).toBe(true);
    expect(changed).toEqual(["changed"]);
  });

  test("updates an existing provider model by value without duplicating it", async () => {
    await editModelCatalogTool({
      operation: "upsertModel",
      providerId: "openrouter",
      modelPreset: { value: "moonshotai/kimi-k3", label: "Old" },
    });
    const out = await editModelCatalogTool({
      operation: "upsertModel",
      providerId: "openrouter",
      modelPreset: { value: "moonshotai/kimi-k3", label: "New" },
    });

    expect(out).toContain('Updated model "moonshotai/kimi-k3"');
    const merged = getMergedCatalog().find((entry) => entry.id === "openrouter")!;
    expect(merged.modelPresets?.filter((preset) => preset.value === "moonshotai/kimi-k3")).toEqual([
      { value: "moonshotai/kimi-k3", label: "New" },
    ]);
  });

  test("rejects model upsert for an unknown provider", async () => {
    const out = await editModelCatalogTool({
      operation: "upsertModel",
      providerId: "missing-provider",
      modelPreset: { value: "model-x" },
    });
    expect(out).toContain("does not exist");
    expect(existsSync(userCatalogPath())).toBe(false);
  });

  test("rejects a known provider host paired with the wrong adapterKind", async () => {
    const out = await editModelCatalogTool({
      entry: baseEntry({
        id: "openrouter-kimi",
        adapterKind: "openai",
        protocol: "openai-compat",
        defaultBaseUrl: "https://openrouter.ai/api/v1",
      }),
    });

    expect(out).toContain("provider mismatch");
    expect(out).toContain('adapterKind="openrouter"');
    expect(existsSync(userCatalogPath())).toBe(false);
    expect(changed).toEqual([]);
  });

  test("accepts OpenRouter as its own provider over the OpenAI-compatible protocol", async () => {
    const out = await editModelCatalogTool({
      entry: baseEntry({
        id: "openrouter-kimi",
        adapterKind: "openrouter",
        protocol: "openai-compat",
        defaultBaseUrl: "https://openrouter.ai/api/v1",
      }),
    });

    expect(out).toContain('Added catalog entry "openrouter-kimi"');
    expect(out).toContain("adapter: openrouter");
    expect(changed).toEqual(["changed"]);
  });

  test("adds a new entry and writes it to the user catalog", async () => {
    const out = await editModelCatalogTool({ entry: baseEntry() });
    expect(out).toContain('Added catalog entry "acme"');
    expect(out).toContain("tag: text | adapter: openai");
    expect(existsSync(userCatalogPath())).toBe(true);
    const written = JSON.parse(readFileSync(userCatalogPath(), "utf-8")) as Array<{ id: string }>;
    expect(written.some((e) => e.id === "acme")).toBe(true);
  });

  test("successful write notifies the host exactly once", async () => {
    await editModelCatalogTool({ entry: baseEntry() });
    expect(changed).toEqual(["changed"]);
  });

  test("validation failure does not notify the host", async () => {
    await editModelCatalogTool({ entry: { id: "bad" } });
    expect(changed).toEqual([]);
  });

  test("persistence failure does not notify the host", async () => {
    writeFileSync(join(home, ".code-shell"), "blocks catalog directory creation");

    const out = await editModelCatalogTool({ entry: baseEntry() });

    expect(out).toStartWith("Error:");
    expect(changed).toEqual([]);
  });

  test("second write to the same id reports 'Updated'", async () => {
    await editModelCatalogTool({ entry: baseEntry() });
    const out = await editModelCatalogTool({ entry: baseEntry({ displayName: "Acme 2" }) });
    expect(out).toContain('Updated catalog entry "acme"');
  });

  test("same id as a built-in provider writes a user override instead of merging presets", async () => {
    const out = await editModelCatalogTool({
      entry: {
        id: "openai",
        tag: "text",
        adapterKind: "openai",
        displayName: "OpenAI patched",
        description: "OpenAI plus a test model",
        defaultBaseUrl: "https://api.openai.com/v1",
        modelPresets: [{ value: "gpt-test-new", label: "GPT Test New" }],
      },
    });
    expect(out).toContain('catalog entry "openai"');
    const written = JSON.parse(readFileSync(userCatalogPath(), "utf-8")) as Array<{
      id: string;
      modelPresets?: Array<{ value: string }>;
    }>;
    const openai = written.find((e) => e.id === "openai")!;
    expect(openai.modelPresets?.some((p) => p.value === "gpt-5.5")).toBe(false);
    expect(openai.modelPresets?.some((p) => p.value === "gpt-test-new")).toBe(true);
  });

  test("(no modelPresets) is surfaced", async () => {
    const out = await editModelCatalogTool({ entry: baseEntry() });
    expect(out).toContain("(no modelPresets)");
  });

  test("echoes enum param options and default", async () => {
    const out = await editModelCatalogTool({
      entry: baseEntry({
        modelPresets: [
          {
            value: "acme-1",
            params: [
              {
                name: "reasoning",
                control: "enum",
                options: ["low", "high", "max"],
                default: "high",
              },
            ],
          },
        ],
      }),
    });
    expect(out).toContain("model: acme-1");
    expect(out).toContain("options=[low, high, max]");
    expect(out).toContain('default="high"');
  });

  test("echoes number param range and limits", async () => {
    const out = await editModelCatalogTool({
      entry: baseEntry({
        modelPresets: [
          {
            value: "acme-2",
            maxContextTokens: 200000,
            maxOutputTokens: 64000,
            params: [{ name: "budget", control: "number", min: 1024, max: 32000, default: 8192 }],
          },
        ],
      }),
    });
    expect(out).toContain("ctx 200000");
    expect(out).toContain("out 64000");
    expect(out).toContain("range 1024..32000");
    expect(out).toContain("default=8192");
  });

  test("a preset with no params says so", async () => {
    const out = await editModelCatalogTool({
      entry: baseEntry({ modelPresets: [{ value: "acme-3" }] }),
    });
    expect(out).toContain("model: acme-3");
    expect(out).toContain("(no params declared)");
  });

  test("summary always asks the user to verify against official docs", async () => {
    const out = await editModelCatalogTool({ entry: baseEntry() });
    expect(out).toContain("OFFICIAL docs");
    expect(out).toContain("Hot-reloads");
  });
});
