import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { editModelCatalogTool } from "./edit-model-catalog.js";
import { userCatalogPath } from "../../model-catalog/index.js";

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

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-emc-home-"));
    process.env.HOME = home;
  });
  afterEach(() => {
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
    const out = await editModelCatalogTool({ entry: { id: "bad", tag: "text", adapterKind: "openai" } });
    expect(out.startsWith("Error:")).toBe(true);
    // The write must NOT have happened.
    expect(existsSync(userCatalogPath())).toBe(false);
  });

  test("adds a new entry and writes it to the user catalog", async () => {
    const out = await editModelCatalogTool({ entry: baseEntry() });
    expect(out).toContain('Added catalog entry "acme"');
    expect(out).toContain("tag: text | adapter: openai");
    expect(existsSync(userCatalogPath())).toBe(true);
    const written = JSON.parse(readFileSync(userCatalogPath(), "utf-8")) as Array<{ id: string }>;
    expect(written.some((e) => e.id === "acme")).toBe(true);
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
            params: [{ name: "reasoning", control: "enum", options: ["low", "high", "max"], default: "high" }],
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
