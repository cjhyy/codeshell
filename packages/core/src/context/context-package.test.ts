import { describe, expect, it } from "bun:test";
import type { Message } from "../types.js";
import {
  CONTEXT_PACKAGE_MAX_OUTPUT_TOKENS,
  CONTEXT_PACKAGE_TARGET_TOKENS,
  buildContextPackagePrompt,
  serializeContextPackageMessages,
} from "./compaction.js";

describe("context transfer summarization prompt", () => {
  it("reuses the /compact nine-section prompt and targets about 1,500 tokens", () => {
    const messages: Message[] = [
      { role: "user", content: "fix packages/core/src/example.ts" },
      { role: "assistant", content: "The failure was TypeError: boom" },
    ];

    const prompt = buildContextPackagePrompt(messages);

    expect(prompt).toContain("1. **Primary Request**");
    expect(prompt).toContain("9. **Next Steps**");
    expect(prompt).toContain("fix packages/core/src/example.ts");
    expect(prompt).toContain("background context package");
    expect(prompt).toContain("1,500");
    expect(CONTEXT_PACKAGE_TARGET_TOKENS).toBe(1_500);
    expect(CONTEXT_PACKAGE_MAX_OUTPUT_TOKENS).toBeGreaterThanOrEqual(1_500);
    expect(CONTEXT_PACKAGE_MAX_OUTPUT_TOKENS).toBeLessThanOrEqual(2_000);
  });

  it("serializes long tails, reasoning, structured tool results, and image metadata without silent loss", () => {
    const longText = `head-${"x".repeat(4_000)}-TAIL`;
    const longArg = `arg-${"y".repeat(700)}-ARG_TAIL`;
    const longResult = `result-${"z".repeat(1_800)}-RESULT_TAIL`;
    const messages: Message[] = [
      { role: "user", content: longText },
      {
        role: "assistant",
        content: [
          { type: "reasoning", reasoningContent: "reasoning-detail" },
          { type: "tool_use", id: "tool-1", name: "Inspect", input: { query: longArg } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: [
              { type: "text", text: longResult },
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "SECRET_BASE64" },
              },
            ],
          },
        ],
      },
    ];

    const serialized = serializeContextPackageMessages(messages);

    expect(serialized.text).toContain("TAIL");
    expect(serialized.text).toContain("ARG_TAIL");
    expect(serialized.text).toContain("RESULT_TAIL");
    expect(serialized.text).toContain("reasoning-detail");
    expect(serialized.text).toContain("[image media_type=image/png encoding=base64");
    expect(serialized.text).not.toContain("SECRET_BASE64");
    expect(serialized.hasSummarizableContent).toBe(true);
  });

  it("marks an image-only selection as having no summarizable facts", () => {
    const serialized = serializeContextPackageMessages([
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: "pixels" },
          },
        ],
      },
    ]);

    expect(serialized.text).toContain("[image media_type=image/jpeg encoding=base64");
    expect(serialized.hasSummarizableContent).toBe(false);
  });
});
