import { describe, it, expect } from "bun:test";
import { toolResultToBlock } from "./turn-loop.js";
import type { ToolResult } from "../types.js";

describe("toolResultToBlock", () => {
  it("uses contentBlocks verbatim when present", () => {
    const r: ToolResult = {
      id: "call_1",
      toolName: "view_image",
      result: "(image)",
      contentBlocks: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      ],
    };
    const block = toolResultToBlock(r);
    expect(block.type).toBe("tool_result");
    expect(block.tool_use_id).toBe("call_1");
    expect(Array.isArray(block.content)).toBe(true);
    expect((block.content as any)[0].type).toBe("image");
  });

  it("falls back to string content when no contentBlocks", () => {
    const r: ToolResult = { id: "call_2", toolName: "Read", result: "hello" };
    const block = toolResultToBlock(r);
    expect(block.content).toBe("hello");
  });

  it("renders error as string content with is_error", () => {
    const r: ToolResult = { id: "call_3", toolName: "Read", error: "boom", isError: true };
    const block = toolResultToBlock(r);
    expect(block.content).toBe("Error: boom");
    expect(block.is_error).toBe(true);
  });
});
