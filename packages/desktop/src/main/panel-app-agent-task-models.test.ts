import { describe, expect, test } from "bun:test";
import { buildPanelAgentTaskModelCatalog } from "./panel-app-agent-task-models.js";

describe("buildPanelAgentTaskModelCatalog", () => {
  test("returns configured text connections without credentials or endpoints", () => {
    const result = buildPanelAgentTaskModelCatalog(
      {
        credentials: [{ id: "secret", apiKey: "never-return-this" }],
        defaults: { text: "fast" },
        modelConnections: [
          {
            id: "fast",
            catalogId: "openai",
            tag: "text",
            model: "gpt-5-mini",
            credentialId: "secret",
            baseUrl: "https://private.example.test",
          },
          { id: "image", catalogId: "openai", tag: "image", model: "gpt-image-1" },
          { id: "stale", catalogId: "missing", tag: "text", model: "unknown" },
        ],
      },
      [
        {
          id: "openai",
          displayName: "OpenAI",
          modelPresets: [{ value: "gpt-5-mini", label: "GPT-5 mini" }],
        },
      ],
    );

    expect(result).toEqual({
      defaultModel: "fast",
      models: [
        {
          id: "fast",
          providerId: "openai",
          provider: "OpenAI",
          model: "gpt-5-mini",
          label: "GPT-5 mini",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("never-return-this");
    expect(JSON.stringify(result)).not.toContain("private.example.test");
  });

  test("omits an invalid default and de-duplicates connection ids", () => {
    const result = buildPanelAgentTaskModelCatalog(
      {
        defaults: { text: "missing" },
        modelConnections: [
          { id: "same", catalogId: "custom", tag: "text", model: "one" },
          { id: "same", catalogId: "custom", tag: "text", model: "two" },
        ],
      },
      [{ id: "custom", displayName: "Custom" }],
    );
    expect(result.defaultModel).toBeUndefined();
    expect(result.models).toHaveLength(1);
    expect(result.models[0]?.model).toBe("one");
  });
});
