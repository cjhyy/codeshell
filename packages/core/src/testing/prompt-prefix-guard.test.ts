import { describe, expect, test } from "bun:test";
import {
  notePromptMessageLeft,
  notePromptPrefixRewrite,
  notePromptRequest,
  setPromptPrefixObserver,
} from "../utils/prompt-prefix-events.js";
import type { Message } from "../types.js";
import { PromptPrefixGuard } from "./prompt-prefix-guard.js";

const user = (content: string): Message => ({ role: "user", content });

function withGuard(run: (guard: PromptPrefixGuard) => void): PromptPrefixGuard {
  const guard = new PromptPrefixGuard();
  const previous = setPromptPrefixObserver(guard);
  try {
    run(guard);
  } finally {
    setPromptPrefixObserver(previous);
  }
  return guard;
}

describe("PromptPrefixGuard", () => {
  test("accepts requests that extend the previous one, per scope", () => {
    const guard = withGuard(() => {
      notePromptRequest("a", [user("1")]);
      notePromptRequest("b", [user("other session")]);
      notePromptRequest("a", [user("1"), { role: "assistant", content: "2" }, user("3")]);
      notePromptRequest("a", [user("1"), { role: "assistant", content: "2" }, user("3")]);
    });
    expect(guard.violations).toEqual([]);
    expect(() => guard.assertClean()).not.toThrow();
  });

  test("flags an unregistered change of an earlier message", () => {
    const guard = withGuard(() => {
      notePromptRequest("a", [user("1"), user("2")]);
      notePromptRequest("a", [user("1"), user("2 rewritten"), user("3")]);
      // A shorter request drops the tail: also a change.
      notePromptRequest("a", [user("1")]);
    });
    expect(guard.violations.map((v) => v.index)).toEqual([1, 1]);
    expect(() => guard.assertClean()).toThrow("Unregistered prompt prefix change");
  });

  test("a registered rewrite excuses the next request only", () => {
    const guard = withGuard(() => {
      notePromptRequest("a", [user("1"), user("2")]);
      notePromptPrefixRewrite("compaction");
      notePromptRequest("a", [user("summary"), user("3")]);
      notePromptRequest("a", [user("other"), user("3")]);
    });
    expect(guard.rewrites).toEqual(["compaction"]);
    expect(guard.violations).toHaveLength(1);
  });

  test("key order and the text-block form of a reply are not changes", () => {
    const guard = withGuard(() => {
      notePromptRequest("a", [
        { role: "user", content: [{ type: "text", text: "x" }] },
        { role: "assistant", content: "reply" },
      ]);
      notePromptRequest("a", [
        { content: [{ text: "x", type: "text" }], role: "user" } as Message,
        { role: "assistant", content: [{ type: "text", text: "reply" }] },
        user("next"),
      ]);
    });
    expect(guard.violations).toEqual([]);
  });

  test("reports are no-ops without an installed guard", () => {
    setPromptPrefixObserver(undefined);
    expect(() => {
      notePromptRequest("a", [user("1")]);
      notePromptPrefixRewrite("archive");
    }).not.toThrow();
  });
});

describe("PromptPrefixGuard volatile messages", () => {
  test("a message that left its place is not a change; the rest must still extend", () => {
    const volatile = user("runtime status");
    const guard = withGuard(() => {
      notePromptRequest("a", [user("1"), volatile]);
      notePromptMessageLeft(volatile);
      notePromptRequest("a", [user("1"), user("2"), volatile]);
      notePromptMessageLeft(volatile);
      notePromptRequest("a", [user("changed"), user("2")]);
    });
    expect(guard.rewrites).toEqual([]);
    expect(guard.violations.map((v) => v.index)).toEqual([0]);
  });
});
