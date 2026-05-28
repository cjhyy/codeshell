import { describe, expect, it } from "bun:test";
import {
  microcompact,
  windowCompact,
} from "../packages/core/src/context/compaction.ts";
import type { Message } from "../packages/core/src/types.ts";

/**
 * Task 10 — compaction idempotency.
 *
 * A second compaction over an already-compacted message list must produce
 * the same result as the first. This is non-trivial: microcompact rewrites
 * old tool_result bodies into a "[Old tool result cleared … (fingerprint)]"
 * sentinel; if the second pass doesn't recognize the sentinel it could try
 * to clear it again (re-prefixing, double-counting eligible rounds, etc.)
 * and the message stream would no longer be a fixed point.
 *
 * windowCompact is structurally similar — keep-first + keep-last-N — and
 * should also be stable when called twice with the same N.
 *
 * The cases below are the regression guard against future compaction
 * rewrites that violate the fixed-point property.
 */

function userText(text: string): Message {
  return { role: "user", content: text };
}

function assistantWithToolUse(name: string, id: string, input: Record<string, unknown>): Message {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input } as unknown as never],
  };
}

function userWithToolResult(toolUseId: string, content: string): Message {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: toolUseId, content } as unknown as never],
  };
}

function readRound(id: string, path: string, body: string): Message[] {
  return [
    assistantWithToolUse("Read", id, { file_path: path }),
    userWithToolResult(id, body),
  ];
}

describe("microcompact — idempotent on already-compacted input", () => {
  it("a second pass over the output is a no-op", () => {
    // Six Read rounds — enough that, with keepRecentN=2, the four older
    // ones get cleared. We then re-compact and verify the result is
    // structurally identical (===-equal serialization).
    const messages: Message[] = [
      userText("start"),
      ...readRound("r1", "/a.ts", "<file a contents>"),
      ...readRound("r2", "/b.ts", "<file b contents>"),
      ...readRound("r3", "/c.ts", "<file c contents>"),
      ...readRound("r4", "/d.ts", "<file d contents>"),
      ...readRound("r5", "/e.ts", "<file e contents>"),
      ...readRound("r6", "/f.ts", "<file f contents>"),
    ];

    const once = microcompact(messages, { keepRecentN: 2 });
    const twice = microcompact(once, { keepRecentN: 2 });

    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it("third pass also unchanged — fixed point holds", () => {
    const messages: Message[] = [
      userText("hi"),
      ...readRound("r1", "/x", "content x"),
      ...readRound("r2", "/y", "content y"),
      ...readRound("r3", "/z", "content z"),
      ...readRound("r4", "/w", "content w"),
    ];
    const once = microcompact(messages, { keepRecentN: 1 });
    const twice = microcompact(once, { keepRecentN: 1 });
    const thrice = microcompact(twice, { keepRecentN: 1 });
    expect(JSON.stringify(thrice)).toBe(JSON.stringify(twice));
  });

  it("never re-prefixes the cleared sentinel on second pass", () => {
    // Concrete proof of the bug we're guarding against: if microcompact
    // wasn't sentinel-aware, "[Old tool result cleared …]" would become
    // "[Old tool result cleared …][Old tool result cleared …]" or grow a
    // doubled fingerprint string.
    const messages: Message[] = [
      userText("hi"),
      ...readRound("r1", "/a", "first body"),
      ...readRound("r2", "/b", "second body"),
      ...readRound("r3", "/c", "third body"),
      ...readRound("r4", "/d", "fourth body"),
    ];
    const once = microcompact(messages, { keepRecentN: 1 });
    const twice = microcompact(once, { keepRecentN: 1 });

    // Look at any tool_result we cleared; the body must not contain TWO
    // "[Old tool result cleared" prefixes.
    for (const msg of twice) {
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content as Array<{
        type: string;
        content?: string;
      }>) {
        if (block.type !== "tool_result") continue;
        const body = block.content ?? "";
        const matches = body.match(/\[Old tool result cleared/g);
        // Either present once (sentinel form) or zero times (kept body).
        expect(matches === null || matches.length === 1).toBe(true);
      }
    }
  });
});

describe("windowCompact — idempotent with the same keepLastN", () => {
  it("a second pass with the same N yields an identical array", () => {
    const messages: Message[] = [
      userText("system intro"),
      userText("turn 1"),
      userText("turn 2"),
      userText("turn 3"),
      userText("turn 4"),
      userText("turn 5"),
      userText("turn 6"),
      userText("turn 7"),
      userText("turn 8"),
    ];
    const once = windowCompact(messages, 3);
    const twice = windowCompact(once, 3);
    expect(twice).toEqual(once);
  });

  it("short input returns identity → trivially idempotent", () => {
    const messages: Message[] = [userText("a"), userText("b")];
    expect(windowCompact(messages, 5)).toBe(messages);
    expect(windowCompact(windowCompact(messages, 5), 5)).toBe(messages);
  });
});
