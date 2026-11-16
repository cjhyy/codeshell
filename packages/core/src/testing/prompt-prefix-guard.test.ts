import { describe, expect, test } from "bun:test";
import {
  notePromptMessageLeft,
  notePromptPrefixRewrite,
  notePromptRequest,
  notePromptUserContextHead,
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
      notePromptPrefixRewrite("compaction", "a");
      notePromptRequest("a", [user("summary"), user("3")]);
      notePromptRequest("a", [user("other"), user("3")]);
    });
    expect(guard.rewrites).toEqual(["compaction"]);
    expect(guard.violations).toHaveLength(1);
  });

  test("a session's rewrite excuses only that session", () => {
    const guard = withGuard(() => {
      notePromptRequest("a", [user("a1")]);
      notePromptRequest("b", [user("b1")]);
      notePromptPrefixRewrite("compaction", "a");
      notePromptRequest("a", [user("a summary")]);
      notePromptRequest("b", [user("b changed")]);
    });
    expect(guard.violations.map((v) => v.scope)).toEqual(["b"]);
  });

  test("a rewrite that names no session excuses every session", () => {
    const guard = withGuard(() => {
      notePromptRequest("a", [user("a1")]);
      notePromptRequest("b", [user("b1")]);
      notePromptPrefixRewrite("compaction", undefined);
      notePromptRequest("a", [user("a changed")]);
      notePromptRequest("b", [user("b changed")]);
    });
    expect(guard.violations).toEqual([]);
  });

  test("key order is not a change", () => {
    const guard = withGuard(() => {
      notePromptRequest("a", [{ role: "user", content: [{ type: "text", text: "x" }] }]);
      notePromptRequest("a", [
        { content: [{ text: "x", type: "text" }], role: "user" } as Message,
        user("next"),
      ]);
    });
    expect(guard.violations).toEqual([]);
  });

  test("a reply's text-block form equals its string only on a route that sends both alike", () => {
    const live: Message[] = [user("q"), { role: "assistant", content: "reply" }];
    const replayed: Message[] = [
      user("q"),
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      user("next"),
    ];
    const alike = withGuard(() => {
      notePromptRequest("a", live, () => true);
      notePromptRequest("a", replayed, () => true);
    });
    expect(alike.violations).toEqual([]);
    const different = withGuard(() => {
      notePromptRequest("a", live);
      notePromptRequest("a", replayed);
    });
    expect(different.violations.map((v) => v.index)).toEqual([1]);
    // A block carrying more than its text is never a plain string.
    const reasoning = withGuard(() => {
      notePromptRequest("a", live, () => true);
      notePromptRequest(
        "a",
        [
          user("q"),
          { role: "assistant", content: [{ type: "text", text: "reply", reasoningContent: "r" }] },
        ],
        () => true,
      );
    });
    expect(reasoning.violations).toHaveLength(1);
  });

  test("reports are no-ops without an installed guard", () => {
    setPromptPrefixObserver(undefined);
    let built = false;
    expect(() => {
      notePromptRequest("a", [user("1")]);
      notePromptPrefixRewrite("archive", "a");
      notePromptUserContextHead("a", () => {
        built = true;
        return "instructions";
      });
    }).not.toThrow();
    // Without a guard the head is never even built.
    expect(built).toBe(false);
  });

  test("a changed user-context head is a registered rewrite of that session", () => {
    const guard = withGuard(() => {
      notePromptUserContextHead("a", () => "rules v1");
      notePromptRequest("a", [user("rules v1"), user("1")]);
      notePromptUserContextHead("a", () => "rules v1");
      notePromptUserContextHead("a", () => "rules v2");
      notePromptRequest("a", [user("rules v2"), user("1"), user("2")]);
    });
    expect(guard.rewrites).toEqual(["user_context_head"]);
    expect(guard.violations).toEqual([]);
  });

  test("the guard remembers a bounded number of heads", () => {
    const guard = withGuard(() => {
      for (let index = 0; index <= 256; index += 1)
        notePromptUserContextHead(`s${index}`, () => "x");
      // The oldest session was forgotten: its next head is a first sighting.
      notePromptUserContextHead("s0", () => "changed");
      notePromptUserContextHead("s256", () => "changed");
    });
    expect(guard.rewrites).toEqual(["user_context_head"]);
  });
});

describe("PromptPrefixGuard volatile messages", () => {
  test("a message that left its place is not a change; the rest must still extend", () => {
    const volatile = user("runtime status");
    const guard = withGuard(() => {
      notePromptRequest("a", [user("1"), volatile]);
      notePromptMessageLeft(volatile, "a");
      notePromptRequest("a", [user("1"), user("2"), volatile]);
      notePromptMessageLeft(volatile);
      notePromptRequest("a", [user("changed"), user("2")]);
    });
    expect(guard.rewrites).toEqual([]);
    expect(guard.violations.map((v) => v.index)).toEqual([0]);
  });
});
