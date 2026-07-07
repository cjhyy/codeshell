import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentBlock, Message } from "../../types.js";
import {
  IMAGE_HISTORY_PLACEHOLDER_PREFIX,
  IMAGE_HISTORY_PLACEHOLDER_SUFFIX,
  collectBase64Images,
  downgradeImagePayloadsInHistory,
} from "../../context/compaction.js";
import { SessionManager } from "../../session/session-manager.js";
import type { ToolContext } from "../context.js";
import { viewImageTool } from "./view-image.js";

const IMAGE_1 = "Zmlyc3QtaW1hZ2U=";
const IMAGE_2 = "c2Vjb25kLWltYWdl";
const IMAGE_3 = "dGhpcmQtaW1hZ2U=";

function image(data: string): ContentBlock {
  return {
    type: "image",
    source: { type: "base64", media_type: "image/png", data },
  };
}

function fixtureMessages(): Message[] {
  return [
    {
      role: "user",
      content: [{ type: "text", text: "first" }, image(IMAGE_1)],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "view_1",
          content: [{ type: "text", text: "nested" }, image(IMAGE_2)],
        },
        image(IMAGE_3),
      ],
    },
  ];
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
  for (const message of messages) {
    if (Array.isArray(message.content)) visit(message.content);
  }
  return out;
}

function ctxWith(
  sm: SessionManager | undefined,
  sessionId: string | undefined,
  cwd: string,
): ToolContext {
  return {
    cwd,
    sessionId,
    llmConfig: { provider: "anthropic", providerKind: "anthropic", model: "claude-sonnet-4-6" },
    engine: {
      getSessionManager: sm ? () => sm : undefined,
    },
  } as unknown as ToolContext;
}

describe("view_image by imageNumber", () => {
  let root: string;
  let sessions: string;
  let sm: SessionManager;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "view-image-number-root-"));
    sessions = await mkdtemp(join(tmpdir(), "view-image-number-sessions-"));
    sm = new SessionManager(sessions);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(sessions, { recursive: true, force: true });
  });

  it("retrieves the same #2 image assigned by image-history downgrade", async () => {
    const messages = fixtureMessages();
    const downgraded = downgradeImagePayloadsInHistory(messages).messages;
    expect(placeholderTexts(downgraded)).toEqual([
      `${IMAGE_HISTORY_PLACEHOLDER_PREFIX}1${IMAGE_HISTORY_PLACEHOLDER_SUFFIX}`,
      `${IMAGE_HISTORY_PLACEHOLDER_PREFIX}2${IMAGE_HISTORY_PLACEHOLDER_SUFFIX}`,
      `${IMAGE_HISTORY_PLACEHOLDER_PREFIX}3${IMAGE_HISTORY_PLACEHOLDER_SUFFIX}`,
    ]);

    const session = sm.create(root, "claude-sonnet-4-6", "anthropic", "imagehist123");
    for (const message of messages) {
      session.transcript.appendMessage(message.role, message.content);
    }

    const out = await viewImageTool({ imageNumber: 2 }, ctxWith(sm, "imagehist123", root));

    expect(typeof out).toBe("object");
    const block = (out as { contentBlocks: ContentBlock[] }).contentBlocks[0]!;
    expect(block.type).toBe("image");
    expect(block.source?.data).toBe(IMAGE_2);
    expect((out as { result?: string }).result).toContain("image #2");
  });

  it("reports the available image count when N is out of range", async () => {
    const session = sm.create(root, "claude-sonnet-4-6", "anthropic", "imageoor123");
    session.transcript.appendMessage("user", fixtureMessages()[0]!.content);

    const out = await viewImageTool({ imageNumber: 5 }, ctxWith(sm, "imageoor123", root));

    expect(typeof out).toBe("string");
    expect(out as string).toContain("image #5");
    expect(out as string).toContain("1");
  });

  it("fails closed when sessionManager or sessionId is unavailable", async () => {
    const withoutManager = await viewImageTool(
      { imageNumber: 1 },
      ctxWith(undefined, "imagehist123", root),
    );
    const withoutSessionId = await viewImageTool({ imageNumber: 1 }, ctxWith(sm, undefined, root));

    expect(typeof withoutManager).toBe("string");
    expect(withoutManager as string).toContain("session");
    expect(typeof withoutSessionId).toBe("string");
    expect(withoutSessionId as string).toContain("session");
  });

  it("does not return image bytes for imageNumber under a non-vision model", async () => {
    const session = sm.create(root, "deepseek-chat", "deepseek", "imagenovision123");
    session.transcript.appendMessage("user", fixtureMessages()[0]!.content);
    const ctx = {
      ...ctxWith(sm, "imagenovision123", root),
      llmConfig: { provider: "deepseek", providerKind: "deepseek", model: "deepseek-chat" },
    } as unknown as ToolContext;

    const out = await viewImageTool({ imageNumber: 1 }, ctx);

    expect(typeof out).toBe("string");
    expect(out as string).toContain("不支持视觉");
  });

  it("rejects oversized history images without returning content blocks", async () => {
    const oversized = Buffer.alloc(6 * 1024 * 1024).toString("base64");
    const session = sm.create(root, "claude-sonnet-4-6", "anthropic", "imagebig123");
    session.transcript.appendMessage("user", [{ type: "text", text: "big" }, image(oversized)]);

    const out = await viewImageTool({ imageNumber: 1 }, ctxWith(sm, "imagebig123", root));

    expect(typeof out).toBe("string");
    expect(out as string).toContain("过大");
  });

  it("requires exactly one of path or imageNumber", async () => {
    const neither = await viewImageTool({}, ctxWith(sm, "imagehist123", root));
    const both = await viewImageTool(
      { path: "a.png", imageNumber: 1 },
      ctxWith(sm, "imagehist123", root),
    );

    expect(neither as string).toContain("path");
    expect(neither as string).toContain("imageNumber");
    expect(both as string).toContain("path");
    expect(both as string).toContain("imageNumber");
  });
});

describe("collectBase64Images", () => {
  it("uses the same numbering order as downgradeImagePayloadsInHistory placeholders", () => {
    const messages = fixtureMessages();
    const collected = collectBase64Images(messages);
    const placeholders = placeholderTexts(downgradeImagePayloadsInHistory(messages).messages);

    expect(collected.map((entry) => entry.imageNumber)).toEqual([1, 2, 3]);
    expect(collected.map((entry) => entry.block.source?.data)).toEqual([IMAGE_1, IMAGE_2, IMAGE_3]);
    expect(placeholders).toEqual(
      collected.map(
        (entry) =>
          `${IMAGE_HISTORY_PLACEHOLDER_PREFIX}${entry.imageNumber}${IMAGE_HISTORY_PLACEHOLDER_SUFFIX}`,
      ),
    );
  });
});
