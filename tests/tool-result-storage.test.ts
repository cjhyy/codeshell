import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyToolResultPersistence,
  createContentReplacementState,
  reconstructContentReplacementState,
  resolveToolResultsDir,
  isPersistedReplacement,
  DEFAULT_PERSIST_THRESHOLD,
} from "../src/context/tool-result-storage.js";
import type { Message } from "../src/types.js";

function bigContent(size: number, fill = "x"): string {
  return fill.repeat(size);
}

function userToolResult(toolUseId: string, content: string): Message {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
  };
}

describe("tool-result-storage", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codeshell-trs-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists results larger than the per-result threshold", () => {
    const content = bigContent(DEFAULT_PERSIST_THRESHOLD + 100);
    const messages: Message[] = [userToolResult("id-1", content)];
    const state = createContentReplacementState();

    const result = applyToolResultPersistence(messages, {
      toolResultsDir: dir,
      state,
    });

    const block = (result[0].content as any)[0];
    expect(isPersistedReplacement(block.content)).toBe(true);
    expect(block.content).toContain("Full output saved to:");
    expect(existsSync(join(dir, "id-1.txt"))).toBe(true);
    expect(readFileSync(join(dir, "id-1.txt"), "utf-8")).toBe(content);
    expect(state.replacements.has("id-1")).toBe(true);
    expect(state.seenIds.has("id-1")).toBe(true);
  });

  it("leaves small results untouched", () => {
    const messages: Message[] = [userToolResult("id-1", "tiny output")];
    const state = createContentReplacementState();

    const result = applyToolResultPersistence(messages, {
      toolResultsDir: dir,
      state,
    });

    const block = (result[0].content as any)[0];
    expect(block.content).toBe("tiny output");
    expect(state.replacements.has("id-1")).toBe(false);
    // Decided "don't persist" → frozen.
    expect(state.seenIds.has("id-1")).toBe(true);
  });

  it("freezes 'don't persist' decisions — same id is left alone on later runs even if it now exceeds threshold", () => {
    const state = createContentReplacementState();
    // First pass: small, decided don't-persist.
    applyToolResultPersistence([userToolResult("id-1", "small")], {
      toolResultsDir: dir,
      state,
    });
    expect(state.seenIds.has("id-1")).toBe(true);
    expect(state.replacements.has("id-1")).toBe(false);

    // Second pass: same id, now huge. Frozen → not persisted.
    const huge = bigContent(DEFAULT_PERSIST_THRESHOLD + 100);
    const result = applyToolResultPersistence([userToolResult("id-1", huge)], {
      toolResultsDir: dir,
      state,
    });
    const block = (result[0].content as any)[0];
    expect(block.content).toBe(huge); // untouched
    expect(existsSync(join(dir, "id-1.txt"))).toBe(false);
  });

  it("re-applies cached replacement byte-identically on repeat calls", () => {
    const content = bigContent(DEFAULT_PERSIST_THRESHOLD + 100);
    const state = createContentReplacementState();

    const first = applyToolResultPersistence([userToolResult("id-1", content)], {
      toolResultsDir: dir,
      state,
    });
    const firstReplacement = (first[0].content as any)[0].content;

    // Call again with the ORIGINAL content (simulating manager.manage()
    // being invoked again with fresh messages from the session loader).
    const second = applyToolResultPersistence([userToolResult("id-1", content)], {
      toolResultsDir: dir,
      state,
    });
    const secondReplacement = (second[0].content as any)[0].content;
    expect(secondReplacement).toBe(firstReplacement);
  });

  it("does not rewrite blocks whose content is already the cached replacement", () => {
    const content = bigContent(DEFAULT_PERSIST_THRESHOLD + 100);
    const state = createContentReplacementState();

    const first = applyToolResultPersistence([userToolResult("id-1", content)], {
      toolResultsDir: dir,
      state,
    });
    // Pass the *already-replaced* messages back in — should be a no-op
    // returning the same message reference for unchanged content.
    const second = applyToolResultPersistence(first, {
      toolResultsDir: dir,
      state,
    });
    // Reference equality on the message: nothing changed in pass 2.
    expect(second[0]).toBe(first[0]);
  });

  it("persists the largest blocks first when a single message busts the aggregate cap", () => {
    // Three results, each well below the per-result threshold, but
    // together over the per-message cap. Tune cap so exactly one must go.
    const cap = 20_000;
    const small = bigContent(5_000, "a");
    const medium = bigContent(7_000, "b");
    const large = bigContent(9_000, "c");
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "id-small", content: small },
          { type: "tool_result", tool_use_id: "id-medium", content: medium },
          { type: "tool_result", tool_use_id: "id-large", content: large },
        ],
      },
    ];
    const state = createContentReplacementState();

    const result = applyToolResultPersistence(messages, {
      toolResultsDir: dir,
      state,
      perResultThreshold: 100_000, // disable per-result trigger
      perMessageCap: cap,
    });

    // 'large' must have been persisted (it's the biggest, and replacing
    // it alone gets us under the cap: 5k + 7k = 12k < 20k).
    const blocks = (result[0].content as any[]);
    expect(blocks[0].content).toBe(small);
    expect(blocks[1].content).toBe(medium);
    expect(isPersistedReplacement(blocks[2].content)).toBe(true);
    expect(state.replacements.has("id-large")).toBe(true);
    expect(state.replacements.has("id-medium")).toBe(false);
    expect(state.replacements.has("id-small")).toBe(false);
  });

  it("invokes onPersist once per freshly persisted block", () => {
    const huge = bigContent(DEFAULT_PERSIST_THRESHOLD + 100);
    const messages: Message[] = [
      userToolResult("id-1", huge),
      userToolResult("id-2", huge),
      userToolResult("id-3", "small"),
    ];
    const state = createContentReplacementState();
    const calls: Array<{ toolUseId: string; reason: string }> = [];

    applyToolResultPersistence(messages, {
      toolResultsDir: dir,
      state,
      onPersist: (info) =>
        calls.push({ toolUseId: info.toolUseId, reason: info.reason }),
    });

    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.toolUseId).sort()).toEqual(["id-1", "id-2"]);
    expect(calls.every((c) => c.reason === "per-result-cap")).toBe(true);
  });

  it("survives EEXIST: writing the same id twice doesn't error", () => {
    const content = bigContent(DEFAULT_PERSIST_THRESHOLD + 100);

    // Pre-create the file (simulating a write from a prior process).
    const stateA = createContentReplacementState();
    applyToolResultPersistence([userToolResult("id-1", content)], {
      toolResultsDir: dir,
      state: stateA,
    });
    expect(existsSync(join(dir, "id-1.txt"))).toBe(true);

    // Fresh state — second call should hit EEXIST and skip gracefully,
    // still producing a replacement string in the message.
    const stateB = createContentReplacementState();
    const result = applyToolResultPersistence([userToolResult("id-1", content)], {
      toolResultsDir: dir,
      state: stateB,
    });
    const block = (result[0].content as any)[0];
    expect(isPersistedReplacement(block.content)).toBe(true);
  });

  it("reconstructs state from messages containing existing persisted replacements", () => {
    const huge = bigContent(DEFAULT_PERSIST_THRESHOLD + 100);
    const stateA = createContentReplacementState();
    const persistedMessages = applyToolResultPersistence(
      [userToolResult("id-1", huge), userToolResult("id-2", "small")],
      { toolResultsDir: dir, state: stateA },
    );

    const replayedState = reconstructContentReplacementState(persistedMessages);
    expect(replayedState.seenIds.has("id-1")).toBe(true);
    expect(replayedState.seenIds.has("id-2")).toBe(true);
    expect(replayedState.replacements.has("id-1")).toBe(true);
    expect(replayedState.replacements.has("id-2")).toBe(false);
    // The reconstructed replacement string should match the live one.
    expect(replayedState.replacements.get("id-1")).toBe(
      stateA.replacements.get("id-1"),
    );
  });

  it("skips blocks already marked as cleared (microcompact sentinel)", () => {
    const messages: Message[] = [
      userToolResult("id-1", "[Old tool result cleared — Read file_path=/foo]"),
    ];
    const state = createContentReplacementState();

    const result = applyToolResultPersistence(messages, {
      toolResultsDir: dir,
      state,
    });
    // The block should be left alone — microcompact already chose to
    // clear it; we don't want to persist a cleared sentinel.
    expect((result[0].content as any)[0].content).toBe(
      "[Old tool result cleared — Read file_path=/foo]",
    );
    expect(state.replacements.has("id-1")).toBe(false);
  });

  it("resolveToolResultsDir places the directory next to the transcript", () => {
    expect(resolveToolResultsDir("/sessions/abc/session.jsonl")).toBe(
      "/sessions/abc/tool-results",
    );
  });

  it("reconstructed state survives a fresh persistence pass with no changes", () => {
    // Cold session: persist a big blob.
    const huge = bigContent(DEFAULT_PERSIST_THRESHOLD + 100);
    const stateA = createContentReplacementState();
    const persistedA = applyToolResultPersistence(
      [userToolResult("id-1", huge)],
      { toolResultsDir: dir, state: stateA },
    );
    const replacementA = (persistedA[0].content as any)[0].content;

    // Simulate resume: rebuild state from the already-persisted messages,
    // then run the engine's manage() path again with the same messages.
    const stateB = reconstructContentReplacementState(persistedA);
    const persistedB = applyToolResultPersistence(persistedA, {
      toolResultsDir: dir,
      state: stateB,
    });
    const replacementB = (persistedB[0].content as any)[0].content;

    // Byte-identical to the cold-run replacement → prompt-prefix stable.
    expect(replacementB).toBe(replacementA);
    // No new write — file was already there; we don't even try.
    expect(persistedB[0]).toBe(persistedA[0]);
  });

  it("does not crash when the tool-results dir has to be created", () => {
    const nested = join(dir, "deeply", "nested");
    // Don't pre-create it.
    expect(existsSync(nested)).toBe(false);

    const huge = bigContent(DEFAULT_PERSIST_THRESHOLD + 100);
    const state = createContentReplacementState();
    const result = applyToolResultPersistence([userToolResult("id-1", huge)], {
      toolResultsDir: nested,
      state,
    });
    expect(isPersistedReplacement((result[0].content as any)[0].content)).toBe(
      true,
    );
    expect(existsSync(join(nested, "id-1.txt"))).toBe(true);
  });

  it("ignores tool_result blocks on non-user messages", () => {
    // A malformed assistant message that happens to carry a tool_result
    // block shouldn't be modified — only user messages contain results
    // in the canonical protocol.
    const huge = bigContent(DEFAULT_PERSIST_THRESHOLD + 100);
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_result", tool_use_id: "id-1", content: huge }],
      },
    ];
    const state = createContentReplacementState();
    const result = applyToolResultPersistence(messages, {
      toolResultsDir: dir,
      state,
    });
    expect((result[0].content as any)[0].content).toBe(huge);
    expect(state.seenIds.has("id-1")).toBe(false);
  });

  it("includes a preview that respects the trailing newline boundary", () => {
    // Build content where the line breaks fall such that we can verify
    // the preview cut happens at a newline (and only if it's in the back half).
    const lines = "line\n".repeat(500); // ~2,500 chars
    const huge = lines + bigContent(DEFAULT_PERSIST_THRESHOLD);
    const state = createContentReplacementState();
    const result = applyToolResultPersistence([userToolResult("id-1", huge)], {
      toolResultsDir: dir,
      state,
    });
    const replacement = (result[0].content as any)[0].content as string;
    // Pull out the preview body between the header and the closing tag.
    const previewStart = replacement.indexOf("Preview");
    const body = replacement.slice(previewStart);
    // Last character of the preview portion before "..." should be \n
    // (we cut at lastIndexOf('\n') if it's in the back half).
    const beforeEllipsis = body.slice(0, body.indexOf("\n..."));
    expect(beforeEllipsis.endsWith("line")).toBe(true);
  });

  it("reconstructs replacements even if the on-disk file was deleted", () => {
    // The state machine identifies persisted blocks by the sentinel in
    // the message content, not by the file existing. Tolerant to log
    // cleanup that wipes the tool-results dir.
    const huge = bigContent(DEFAULT_PERSIST_THRESHOLD + 100);
    const stateA = createContentReplacementState();
    const persisted = applyToolResultPersistence(
      [userToolResult("id-1", huge)],
      { toolResultsDir: dir, state: stateA },
    );
    rmSync(join(dir, "id-1.txt"));

    const stateB = reconstructContentReplacementState(persisted);
    expect(stateB.replacements.has("id-1")).toBe(true);
  });

  it("does not write a file for a block under the threshold even with onPersist set", () => {
    const calls: number[] = [];
    const state = createContentReplacementState();
    applyToolResultPersistence([userToolResult("id-1", "ok")], {
      toolResultsDir: dir,
      state,
      onPersist: () => calls.push(1),
    });
    expect(calls).toHaveLength(0);
    expect(existsSync(join(dir, "id-1.txt"))).toBe(false);
  });

  it("multiple parallel results in one message are all persisted when each exceeds the per-result threshold", () => {
    const huge = bigContent(DEFAULT_PERSIST_THRESHOLD + 100);
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "id-a", content: huge },
          { type: "tool_result", tool_use_id: "id-b", content: huge },
          { type: "tool_result", tool_use_id: "id-c", content: huge },
        ],
      },
    ];
    const state = createContentReplacementState();
    const result = applyToolResultPersistence(messages, {
      toolResultsDir: dir,
      state,
    });
    const blocks = result[0].content as any[];
    expect(blocks.every((b) => isPersistedReplacement(b.content))).toBe(true);
    expect(state.replacements.size).toBe(3);
  });

  it("Pass 2 does not roll back a block that microcompact already cleared", () => {
    // Reproduces the persistence/microcompact overwrite loop: once a block
    // has been replaced with the "[Old tool result cleared …]" fingerprint
    // (by microcompact, downstream of persistence), running persistence
    // again on the resulting messages must NOT restore the <persisted-output>
    // form. Otherwise each turn does two redundant rewrites.
    const content = bigContent(DEFAULT_PERSIST_THRESHOLD + 100);
    const state = createContentReplacementState();

    // Turn 1: persist.
    const turn1 = applyToolResultPersistence([userToolResult("id-1", content)], {
      toolResultsDir: dir,
      state,
    });
    const persistedReplacement = state.replacements.get("id-1");
    expect(persistedReplacement).toBeDefined();
    expect(isPersistedReplacement((turn1[0].content as any)[0].content)).toBe(true);

    // Simulate microcompact clearing the block downstream of persistence.
    const cleared: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "id-1",
            content: "[Old tool result cleared — Read file_path=/tmp/foo.txt]",
          },
        ],
      },
    ];

    // Turn 2: persistence runs again on the cleared messages. It must
    // leave the cleared fingerprint alone, NOT rewrite to persistedReplacement.
    const turn2 = applyToolResultPersistence(cleared, {
      toolResultsDir: dir,
      state,
    });
    const block = (turn2[0].content as any)[0];
    expect(block.content).toBe("[Old tool result cleared — Read file_path=/tmp/foo.txt]");
    // Reference equality: nothing in `cleared` should have been rewritten.
    expect(turn2).toBe(cleared);
  });
});
