import { describe, expect, test } from "bun:test";
import {
  buildExtractionPrompt,
  buildExtractionPromptSegments,
  type ExistingMemorySummary,
} from "./extract-memories.js";
import { buildSessionMemoryPrompt, buildSessionMemoryPromptSegments } from "./session-memory.js";
import { formatMemoryTranscript, layoutMemoryTranscript } from "./memory-transcript.js";
import type { MemoryPromptSegments } from "./memory-prompt-segments.js";

type Turn = { role: string; content: string };

function turns(count: number, chars: number, from = 0): Turn[] {
  return Array.from({ length: count }, (_, offset) => {
    const index = from + offset;
    return {
      role: index % 2 ? "assistant" : "user",
      content: `TURN_${index} ${"x".repeat(chars)}`,
    };
  });
}

/** Number of leading messages that are byte-identical in both requests. */
function sharedMessages(a: MemoryPromptSegments, b: MemoryPromptSegments): number {
  let shared = 0;
  while (
    shared < a.stable.length &&
    shared < b.stable.length &&
    a.stable[shared] === b.stable[shared]
  )
    shared++;
  return shared;
}

const memory = (
  name: string,
  extra: Partial<ExistingMemorySummary> = {},
): ExistingMemorySummary => ({
  id: name,
  name,
  type: "project",
  description: `${name} description`,
  location: "project",
  memoryScope: "dream",
  origin: "auto",
  useCount: 0,
  ...extra,
});

describe("append-only memory transcript layout", () => {
  test("rendering is unchanged for a conversation within the budget", () => {
    const messages = turns(12, 700);
    const layout = layoutMemoryTranscript(messages, 2000);
    expect(layout.sealed.join("") + layout.open).toBe(
      messages.map(({ role, content }) => `[${role}]: ${content}`).join("\n\n"),
    );
    expect(formatMemoryTranscript(messages, 2000)).toBe(layout.sealed.join("") + layout.open);
    expect(layout.sealed.length).toBeGreaterThan(1);
  });

  test("a longer transcript keeps every sealed piece of the shorter one", () => {
    const first = turns(12, 700);
    const before = layoutMemoryTranscript(first, 2000);
    const after = layoutMemoryTranscript([...first, ...turns(5, 700, 12)], 2000);

    expect(after.sealed.slice(0, before.sealed.length)).toEqual(before.sealed);
    expect(after.sealed.join("") + after.open).toStartWith(before.sealed.join("") + before.open);
    // What is left unsealed is small: the next call re-sends at most this much.
    expect(before.open.length).toBeLessThan(2_800);
  });

  test("once over budget the window start moves in large steps, not every call", () => {
    // ~2.9k chars per message: the 30k budget is exceeded after about ten.
    let messages = turns(14, 2880);
    let previous = layoutMemoryTranscript(messages, 3000);
    expect(previous.sealed.join("")).toContain("[... earlier conversation omitted ...]");

    let moved = 0;
    const appended = 12;
    for (let step = 0; step < appended; step++) {
      messages = [...messages, ...turns(1, 2880, messages.length)];
      const next = layoutMemoryTranscript(messages, 3000);
      const text = next.sealed.join("") + next.open;
      expect(text.length).toBeLessThanOrEqual(30_000);
      expect(text).toStartWith("[user]: TURN_0 ");
      expect(text).toContain(`TURN_${messages.length - 1} `);
      if (!text.startsWith(previous.sealed.join(""))) moved++;
      previous = next;
    }
    // A sliding window would move on all 12 appends.
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThanOrEqual(4);
  });
});

describe.each([
  {
    name: "memory extraction",
    build: (transcript: Turn[], existing: ExistingMemorySummary[]) =>
      buildExtractionPromptSegments(transcript, existing),
    full: (transcript: Turn[], existing: ExistingMemorySummary[]) =>
      buildExtractionPrompt(transcript, existing),
  },
  {
    name: "session summary",
    build: (transcript: Turn[], _existing: ExistingMemorySummary[]) =>
      buildSessionMemoryPromptSegments(transcript),
    full: (transcript: Turn[], _existing: ExistingMemorySummary[]) =>
      buildSessionMemoryPrompt(transcript),
  },
])("$name prompt prefix", ({ build, full }) => {
  const transcript = turns(14, 900);
  const existing = [memory("alpha"), memory("beta")];

  test("the single-string prompt is the concatenation of the segments", () => {
    const segments = build(transcript, existing);
    expect(segments.stable.join("") + segments.volatile).toBe(full(transcript, existing));
  });

  test("the next run's request starts with this run's stable messages, byte for byte", () => {
    const before = build(transcript, existing);
    const after = build(
      [...transcript, ...turns(4, 900, 14)],
      // One memory added, one updated and bumped, order changed.
      [memory("gamma"), memory("beta", { useCount: 3, description: "rewritten" }), memory("alpha")],
    );

    expect(before.stable.length).toBeGreaterThan(2);
    expect(sharedMessages(before, after)).toBe(before.stable.length);

    // The stable messages carry the instructions and nearly all of T.
    const stableChars = before.stable.join("").length;
    const rendered = formatMemoryTranscript(transcript, 3000).length;
    expect(before.stable[0]).not.toContain("TURN_");
    expect(before.stable.join("")).toContain("TURN_0 ");
    expect(stableChars).toBeGreaterThan(before.stable[0]!.length + rendered * 0.8);
  });

  test("volatile values never appear in the stable messages", () => {
    const segments = build(transcript, [memory("alpha", { useCount: 41, updateCount: 7 })]);
    const stable = segments.stable.join("");
    expect(stable).not.toContain("alpha description");
    expect(stable).not.toContain("use:41");
    expect(segments.volatile).toContain(`TURN_${transcript.length - 1} `);
  });
});

describe("memory extraction prompt order", () => {
  test("fixed instructions, then conversation, then existing memories, then the task", () => {
    const prompt = buildExtractionPrompt(turns(8, 300), [memory("alpha")]);
    const order = [
      "## Instructions",
      "AT MOST 1",
      "## Conversation",
      "TURN_0 ",
      "TURN_7 ",
      "## Existing Memories",
      "alpha description",
      "Respond with a JSON array",
    ].map((needle) => prompt.indexOf(needle));

    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(prompt).not.toContain("list above");
  });

  test("the instruction message is identical for every session and memory store", () => {
    const one = buildExtractionPromptSegments(turns(8, 300), [memory("alpha")]);
    const other = buildExtractionPromptSegments(turns(30, 1200, 100), []);
    expect(other.stable[0]).toBe(one.stable[0]!);
    expect(other.volatile).toContain("(none)");
  });
});
