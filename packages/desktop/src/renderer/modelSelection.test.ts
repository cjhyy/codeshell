import { describe, expect, it } from "bun:test";
import { persistDefaultTextModel } from "./modelSelection";

describe("persistDefaultTextModel", () => {
  it("persists the selected text model through the settings-change writer", async () => {
    const calls: unknown[] = [];

    await persistDefaultTextModel({
      key: "openrouter",
      getSettings: async () => ({
        defaults: { text: "deepseek", image: "openai-images" },
      }),
      writeSettings: async (scope, patch) => {
        calls.push([scope, patch]);
      },
    });

    expect(calls).toEqual([
      [
        "user",
        {
          defaults: {
            text: "openrouter",
            image: "openai-images",
          },
        },
      ],
    ]);
  });

  it("preserves existing defaults when none are configured", async () => {
    const calls: unknown[] = [];

    await persistDefaultTextModel({
      key: "zhipu-glm-5-2-1m",
      getSettings: async () => ({}),
      writeSettings: async (scope, patch) => {
        calls.push([scope, patch]);
      },
    });

    expect(calls).toEqual([
      [
        "user",
        {
          defaults: {
            text: "zhipu-glm-5-2-1m",
          },
        },
      ],
    ]);
  });
});
