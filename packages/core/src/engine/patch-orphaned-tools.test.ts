import { describe, test, expect } from "bun:test";
import { patchOrphanedToolUses } from "./patch-orphaned-tools.js";
import type { Message, ContentBlock } from "../types.js";

function asst(...ids: string[]): Message {
  return {
    role: "assistant",
    content: ids.map((id) => ({ type: "tool_use" as const, id, name: "T", input: {} })),
  } as unknown as Message;
}
function result(id: string): Message {
  return {
    role: "user",
    content: [{ type: "tool_result" as const, tool_use_id: id, content: "ok" }],
  } as unknown as Message;
}
function toolResultsFor(messages: Message[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) if (b.type === "tool_result") out.push(b);
  }
  return out;
}

describe("patchOrphanedToolUses", () => {
  test("patches EVERY assistant gap, not just the most recent one", () => {
    // Two separate turns each leave an orphaned tool_use; an answered turn sits
    // between them. The old backward-scan-with-early-return would stop at the
    // answered turn and miss the earliest orphan.
    const messages: Message[] = [
      asst("a1"), // orphan (no result)
      asst("b1"),
      result("b1"), // answered
      asst("c1"), // orphan (no result)
    ];

    const summary = patchOrphanedToolUses(messages);

    expect(summary.gapsPatched).toBe(2);
    expect(summary.toolResultsInjected).toBe(2);
    const answered = new Set(toolResultsFor(messages).map((b) => b.tool_use_id));
    expect(answered.has("a1")).toBe(true);
    expect(answered.has("b1")).toBe(true);
    expect(answered.has("c1")).toBe(true);
  });

  test("synthetic results are flagged is_error so the model sees a failure", () => {
    const messages: Message[] = [asst("x1")];
    patchOrphanedToolUses(messages);
    const synth = toolResultsFor(messages).find((b) => b.tool_use_id === "x1");
    expect(synth).toBeDefined();
    expect(synth!.is_error).toBe(true);
  });

  test("inserts the synthetic result immediately after its assistant message", () => {
    const messages: Message[] = [asst("a1"), asst("b1"), result("b1")];
    patchOrphanedToolUses(messages);
    // a1's result must come right after index 0 (the assistant that issued it),
    // i.e. before b1's assistant message — not appended at the end.
    expect(messages[1].role).toBe("user");
    const blocks = messages[1].content as ContentBlock[];
    expect(blocks[0].tool_use_id).toBe("a1");
  });

  test("no gaps → no change, idempotent", () => {
    const messages: Message[] = [asst("a1"), result("a1")];
    const before = JSON.stringify(messages);
    const s1 = patchOrphanedToolUses(messages);
    expect(s1.gapsPatched).toBe(0);
    expect(JSON.stringify(messages)).toBe(before);
    // second pass is also a no-op
    const s2 = patchOrphanedToolUses(messages);
    expect(s2.gapsPatched).toBe(0);
  });
});
