import { describe, expect, it } from "bun:test";

import type { ContentBlock, Message } from "../types.js";
import { estimateMessagesTokens } from "./token-counter.js";

describe("token counter image estimation", () => {
  it("does not treat Anthropic base64 image bytes as text tokens", () => {
    const image: ContentBlock = {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: "A".repeat(4_000_000),
      },
    };
    const messages: Message[] = [{ role: "user", content: [image] }];

    expect(estimateMessagesTokens(messages)).toBeLessThanOrEqual(500);
  });

  it("does not treat an OpenAI data URL as text tokens", () => {
    const image = {
      type: "image",
      image_url: { url: `data:image/jpeg;base64,${"A".repeat(4_000_000)}` },
    } as unknown as ContentBlock;
    const messages: Message[] = [{ role: "user", content: [image] }];

    expect(estimateMessagesTokens(messages)).toBeLessThanOrEqual(500);
  });
});
