import { describe, expect, test } from "bun:test";
import type { Message } from "../types.js";
import { PromptPrefixGuard } from "../testing/prompt-prefix-guard.js";
import { setPromptPrefixObserver } from "../utils/prompt-prefix-events.js";
import { PromptPrefixHeads } from "./prompt-prefix-heads.js";

const head = (text: string): Message => ({ role: "user", content: text });

describe("instruction prefix diagnostics", () => {
  test("does not serialize or retain heads unless a guard is installed", () => {
    const previous = setPromptPrefixObserver(undefined);
    try {
      const heads = new PromptPrefixHeads();
      const inaccessible = {
        role: "user",
        get content() {
          throw new Error("must not read");
        },
      };
      expect(() => heads.note("s", inaccessible as Message)).not.toThrow();
      expect((heads as any).hashes.size).toBe(0);
    } finally {
      setPromptPrefixObserver(previous);
    }
  });

  test("stores bounded hashes and registers changes only for the owning session", () => {
    const guard = new PromptPrefixGuard();
    const previous = setPromptPrefixObserver(guard);
    try {
      const heads = new PromptPrefixHeads();
      heads.note("a", head("private instruction body"));
      const hashes = (heads as any).hashes as Map<string, string>;
      expect(hashes.get("a")).toHaveLength(64);
      expect(hashes.get("a")).not.toContain("private instruction body");
      guard.request("a", [head("before")]);
      guard.request("b", [head("before")]);
      heads.note("a", head("private instruction body"));
      expect(guard.rewrites).toEqual([]);
      heads.note("a", head("changed"));
      guard.request("a", [head("after")]);
      guard.request("b", [head("after")]);
      expect(guard.violations.map((v) => v.scope)).toEqual(["b"]);
      for (let index = 0; index < 128; index++) heads.note(`s-${index}`, head("other"));
      expect(hashes.size).toBe(128);
      expect(hashes.has("a")).toBe(false);
      setPromptPrefixObserver(undefined);
      heads.note("none", head("nothing retained"));
      expect(hashes.size).toBe(0);
    } finally {
      setPromptPrefixObserver(previous);
    }
  });
});
