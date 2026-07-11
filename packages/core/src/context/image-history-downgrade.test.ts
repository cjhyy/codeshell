import { describe, expect, test } from "bun:test";
import type { ContentBlock, Message } from "../types.js";
import {
  IMAGE_HISTORY_PLACEHOLDER_PREFIX,
  downgradeImagePayloadsInHistory,
  estimateTokens,
} from "./compaction.js";

const bigBase64 = "A".repeat(48_000);

function anthropicImage(data = bigBase64): ContentBlock {
  return {
    type: "image",
    source: { type: "base64", media_type: "image/png", data },
  };
}

function openAIImageUrl(data = bigBase64): ContentBlock {
  return {
    type: "image_url",
    image_url: { url: `data:image/png;base64,${data}` },
  } as unknown as ContentBlock;
}

function hasBase64(messages: Message[], needle = bigBase64): boolean {
  return JSON.stringify(messages).includes(needle);
}

function placeholderTexts(messages: Message[]): string[] {
  const out: string[] = [];
  const visit = (blocks: ContentBlock[]) => {
    for (const block of blocks) {
      if (block.type === "text" && block.text?.startsWith(IMAGE_HISTORY_PLACEHOLDER_PREFIX)) {
        out.push(block.text);
      }
      if (block.type === "tool_result" && Array.isArray(block.content)) {
        visit(block.content);
      }
    }
  };
  for (const msg of messages) {
    if (Array.isArray(msg.content)) visit(msg.content);
  }
  return out;
}

describe("downgradeImagePayloadsInHistory", () => {
  test("keeps current-turn image base64, then replaces it with a stable placeholder later", () => {
    const firstUserMessage: Message = {
      role: "user",
      content: [{ type: "text", text: "look at this" }, anthropicImage()],
    };
    const messages: Message[] = [firstUserMessage];

    const firstSend = downgradeImagePayloadsInHistory(messages, {
      preserveMessages: new Set([firstUserMessage]),
    });
    expect(firstSend.messages).toBe(messages);
    expect(firstSend.replacedCount).toBe(0);
    expect(hasBase64(firstSend.messages)).toBe(true);

    const laterTurn = downgradeImagePayloadsInHistory(firstSend.messages);
    expect(laterTurn.replacedCount).toBe(1);
    expect(hasBase64(laterTurn.messages)).toBe(false);
    expect(placeholderTexts(laterTurn.messages)).toEqual([
      "[image #1, 已处理 / already provided earlier]",
    ]);

    const twice = downgradeImagePayloadsInHistory(laterTurn.messages);
    expect(twice.replacedCount).toBe(0);
    expect(twice.messages).toBe(laterTurn.messages);
    expect(placeholderTexts(twice.messages)).toEqual(placeholderTexts(laterTurn.messages));
  });

  test("image payload removal lowers the fixed vision estimate without counting base64 bytes", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "screenshot" }, anthropicImage()] },
    ];
    const before = estimateTokens(messages);
    const afterMessages = downgradeImagePayloadsInHistory(messages).messages;
    const after = estimateTokens(afterMessages);

    expect(hasBase64(afterMessages)).toBe(false);
    expect(before).toBeLessThanOrEqual(500);
    expect(before).toBeGreaterThan(after);
  });

  test("handles OpenAI-style image_url data URLs", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "openai shape" }, openAIImageUrl()] },
    ];

    const out = downgradeImagePayloadsInHistory(messages);
    expect(out.replacedCount).toBe(1);
    expect(hasBase64(out.messages)).toBe(false);
    expect(placeholderTexts(out.messages)).toEqual([
      "[image #1, 已处理 / already provided earlier]",
    ]);
  });

  test("downgrades nested tool_result image blocks produced by vision tools", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "view_1",
            content: [{ type: "text", text: "view_image result" }, anthropicImage()],
          },
        ],
      },
    ];

    const out = downgradeImagePayloadsInHistory(messages);
    expect(out.replacedCount).toBe(1);
    expect(hasBase64(out.messages)).toBe(false);
    expect(placeholderTexts(out.messages)).toEqual([
      "[image #1, 已处理 / already provided earlier]",
    ]);
  });

  test("leaves non-image content untouched", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "plain text" },
          { type: "tool_result", tool_use_id: "r1", content: "tool output" },
        ],
      },
    ];

    const out = downgradeImagePayloadsInHistory(messages);
    expect(out.replacedCount).toBe(0);
    expect(out.messages).toBe(messages);
    expect(out.messages).toEqual(messages);
  });
});
