import { beforeEach, describe, expect, test } from "bun:test";
import { ContextManager, type ContextManagerConfig } from "./manager.js";
import { decideRewriteBatch, resetPromptCacheWarmthForTests } from "./rewrite-gate.js";
import type { ContentBlock, Message } from "../types.js";

const MINUTE = 60_000;

/** assistant tool_use(browser_observe snapshot) + user tool_result. */
function snapTurn(id: string, content: string): Message[] {
  return [
    { role: "assistant", content: [{ type: "tool_use", id, name: "browser_observe", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
  ];
}

function readTurn(id: string, path: string, content: string): Message[] {
  return [
    {
      role: "assistant",
      content: [{ type: "tool_use", id, name: "Read", input: { file_path: path } }],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
  ];
}

/** Plain prose of roughly `tokens` estimated tokens (4 chars/token × the 4/3 safety factor). */
function prose(tokens: number, seed = "word"): string {
  return `${seed} `.repeat(Math.ceil((tokens * 3) / (seed.length + 1)));
}

function resultTexts(messages: Message[]): string[] {
  return messages
    .flatMap((m) => (Array.isArray(m.content) ? (m.content as ContentBlock[]) : []))
    .filter((b) => b.type === "tool_result")
    .map((b) => String(b.content));
}

function makeManager(
  clock: { now: number },
  config: Partial<ContextManagerConfig> = {},
  transcriptPath?: string,
): ContextManager {
  const cm = new ContextManager({ maxTokens: 200_000, now: () => clock.now, ...config });
  if (transcriptPath) cm.setTranscriptPath(transcriptPath);
  return cm;
}

type Runner = (cm: ContextManager, messages: Message[]) => Promise<Message[]>;
const runners: Array<[string, Runner]> = [
  ["manage", async (cm, messages) => cm.manage(messages)],
  ["manageAsync", (cm, messages) => cm.manageAsync(messages)],
];

beforeEach(() => {
  resetPromptCacheWarmthForTests();
});

describe("decideRewriteBatch", () => {
  const base = {
    now: 10 * MINUTE,
    lastRequestAt: 10 * MINUTE - 1_000,
    promptCacheTtlMs: 30 * MINUTE,
    pendingSavedTokens: 100,
    totalTokens: 100_000,
    minSavedTokens: 4_000,
    savedRatio: 0.15,
    pressureTokens: 170_000,
  };

  test("warm, small saving, no pressure → deferred", () => {
    expect(decideRewriteBatch(base)).toBeUndefined();
  });

  test("no request recorded → cold", () => {
    expect(decideRewriteBatch({ ...base, lastRequestAt: undefined })).toBe("cold");
  });

  test("last request older than the TTL → cold; exactly at the TTL is still warm", () => {
    expect(decideRewriteBatch({ ...base, lastRequestAt: base.now - 30 * MINUTE - 1 })).toBe("cold");
    expect(decideRewriteBatch({ ...base, lastRequestAt: base.now - 30 * MINUTE })).toBeUndefined();
  });

  test("worth it needs max(minSavedTokens, ratio × total)", () => {
    // ratio × total = 15_000 dominates the 4_000 floor.
    expect(decideRewriteBatch({ ...base, pendingSavedTokens: 14_999 })).toBeUndefined();
    expect(decideRewriteBatch({ ...base, pendingSavedTokens: 15_000 })).toBe("worth_it");
    // Small history: the absolute floor dominates.
    const small = { ...base, totalTokens: 10_000 };
    expect(decideRewriteBatch({ ...small, pendingSavedTokens: 3_999 })).toBeUndefined();
    expect(decideRewriteBatch({ ...small, pendingSavedTokens: 4_000 })).toBe("worth_it");
  });

  test("history at the first non-micro compaction gate → pressure", () => {
    expect(decideRewriteBatch({ ...base, totalTokens: 170_000 })).toBe("pressure");
  });
});

for (const [name, run] of runners) {
  describe(`ContextManager rewrite batching (${name})`, () => {
    test("cold (no request noted) → batch applied immediately", async () => {
      const clock = { now: 1_000_000 };
      const cm = makeManager(clock);
      const messages = [...snapTurn("s1", prose(500, "old")), ...snapTurn("s2", prose(500, "new"))];

      const out = await run(cm, messages);

      expect(resultTexts(out)[0]).toContain("collapsed");
      expect(cm.getPendingRewriteBoundaryMessage()).toBeUndefined();
    });

    test("warm + small saving → nothing rewritten, even when another snapshot arrives", async () => {
      const clock = { now: 1_000_000 };
      const cm = makeManager(clock);
      const compactions: string[] = [];
      cm.setOnCompact((info) => compactions.push(info.strategy));
      cm.noteModelRequestCompleted();

      const first = [
        { role: "user", content: "start" } as Message,
        ...snapTurn("s1", prose(500, "one")),
        ...snapTurn("s2", prose(500, "two")),
      ];
      clock.now += 5_000;
      const out1 = await run(cm, first);
      expect(out1).toEqual(first);
      // The boundary is exposed by identity, for callers that re-index the list.
      expect(cm.getPendingRewriteBoundaryMessage()).toBe(first[2]);

      cm.noteModelRequestCompleted();
      clock.now += 5_000;
      const second = [...out1, ...snapTurn("s3", prose(500, "three"))];
      const out2 = await run(cm, second);
      expect(out2).toEqual(second);
      // Untouched history keeps the very same message objects (byte-identical prefix).
      for (let i = 0; i < first.length; i++) expect(out2[i]).toBe(first[i]);
      expect(cm.getPendingRewriteBoundaryMessage()).toBe(first[2]);
      expect(compactions).toEqual([]);
    });

    test("cold after the TTL elapsed → applied", async () => {
      const clock = { now: 1_000_000 };
      const cm = makeManager(clock);
      cm.noteModelRequestCompleted();
      const messages = [...snapTurn("s1", prose(500, "old")), ...snapTurn("s2", prose(500, "new"))];

      clock.now += 29 * MINUTE;
      expect(await run(cm, messages)).toEqual(messages);

      clock.now += 2 * MINUTE;
      const out = await run(cm, messages);
      expect(resultTexts(out)[0]).toContain("collapsed");
      expect(cm.getPendingRewriteBoundaryMessage()).toBeUndefined();
    });

    test("promptCacheTtlMs is configurable", async () => {
      const clock = { now: 1_000_000 };
      const cm = makeManager(clock, { promptCacheTtlMs: 5 * MINUTE });
      cm.noteModelRequestCompleted();
      const messages = [...snapTurn("s1", prose(500, "old")), ...snapTurn("s2", prose(500, "new"))];
      clock.now += 6 * MINUTE;
      expect(resultTexts(await run(cm, messages))[0]).toContain("collapsed");
    });

    test("accumulated pending savings reach the threshold → everything applied in ONE call", async () => {
      const clock = { now: 1_000_000 };
      const cm = makeManager(clock);
      cm.noteModelRequestCompleted();

      // ~1.5k pending after the 2nd snapshot and ~3k after the 3rd: below the 4k floor.
      let messages: Message[] = [
        { role: "user", content: "start" },
        ...readTurn("r1", "/a.ts", prose(300, "read")),
        ...snapTurn("s1", prose(1_500, "one")),
        ...snapTurn("s2", prose(1_500, "two")),
      ];
      messages = await run(cm, messages);
      messages = await run(cm, [...messages, ...snapTurn("s3", prose(1_500, "three"))]);
      expect(resultTexts(messages).some((t) => t.includes("collapsed"))).toBe(false);
      expect(cm.getPendingRewriteBoundaryMessage()).toBe(messages[4]);

      // A duplicate Read plus a 4th snapshot push pending savings past 4k.
      const next = [
        ...messages,
        ...readTurn("r2", "/a.ts", prose(300, "read")),
        ...snapTurn("s4", prose(1_500, "four")),
      ];
      const out = await run(cm, next);
      const texts = resultTexts(out);
      expect(texts[0]).toContain("superseded by a newer Read");
      expect(texts[1]).toContain("collapsed");
      expect(texts[2]).toContain("collapsed");
      expect(texts[3]).toContain("collapsed");
      expect(texts[5]).toBe(prose(1_500, "four"));
      expect(cm.getPendingRewriteBoundaryMessage()).toBeUndefined();
    });

    test("thresholds are configurable", async () => {
      const clock = { now: 1_000_000 };
      const cm = makeManager(clock, { rewriteBatchMinSavedTokens: 100, rewriteBatchSavedRatio: 0 });
      cm.noteModelRequestCompleted();
      const messages = [...snapTurn("s1", prose(500, "old")), ...snapTurn("s2", prose(500, "new"))];
      expect(resultTexts(await run(cm, messages))[0]).toContain("collapsed");
    });

    test("pressure: history above the compaction gate → cheap cleanup applied first", async () => {
      const clock = { now: 1_000_000 };
      // Gate at 0.85 × 10k = 8.5k tokens; history ≈ 8.9k. Collapsing s1 frees
      // ~2k: below the 4k "worth it" floor, but enough to avoid snip/window.
      const cm = makeManager(clock, { maxTokens: 10_000 });
      const compactions: string[] = [];
      cm.setOnCompact((info) => compactions.push(info.strategy));
      cm.noteModelRequestCompleted();
      const messages: Message[] = [
        { role: "user", content: "start" },
        ...snapTurn("s1", prose(2_000, "old")),
        { role: "assistant", content: prose(2_400, "alpha") },
        { role: "user", content: prose(2_400, "beta") },
        ...snapTurn("s2", prose(2_000, "new")),
      ];

      const out = await run(cm, messages);

      expect(resultTexts(out)[0]).toContain("collapsed");
      expect(resultTexts(out)[1]).toBe(prose(2_000, "new"));
      expect(compactions).toEqual([]);
      expect(cm.getPendingRewriteBoundaryMessage()).toBeUndefined();
    });

    test("microcompact joins the batch only above its floor, and is deferred while warm", async () => {
      const clock = { now: 1_000_000 };
      // Floor 0.7 × 10k = 7k; gate 8.5k. 8 Read rounds × ~950 tokens ≈ 7.7k.
      const cm = makeManager(clock, { maxTokens: 10_000, microcompactKeepRecent: 6 });
      const compactions: string[] = [];
      cm.setOnCompact((info) => compactions.push(info.strategy));
      cm.noteModelRequestCompleted();
      const messages: Message[] = [{ role: "user", content: "start" }];
      for (let i = 0; i < 8; i++) {
        messages.push(...readTurn(`r${i}`, `/f${i}.ts`, prose(950, `file${i}`)));
      }

      // ~1.9k saving < max(4k, 15%) → deferred, earliest rewrite is round 0's result.
      const deferred = await run(cm, messages);
      expect(deferred).toEqual(messages);
      expect(cm.getPendingRewriteBoundaryMessage()).toBe(messages[2]);
      expect(compactions).toEqual([]);

      clock.now += 31 * MINUTE;
      const applied = await run(cm, messages);
      const texts = resultTexts(applied);
      expect(texts[0]).toContain("Old tool result cleared");
      expect(texts[1]).toContain("Old tool result cleared");
      expect(texts[2]).toBe(prose(950, "file2"));
      expect(compactions).toContain("micro");
      expect(cm.getPendingRewriteBoundaryMessage()).toBeUndefined();
    });

    test("warmth is shared across ContextManager instances of the same session", async () => {
      const clock = { now: 1_000_000 };
      const path = `/tmp/rewrite-gate-${name}/session-a/transcript.jsonl`;
      const firstRun = makeManager(clock, {}, path);
      firstRun.noteModelRequestCompleted();

      clock.now += 20_000;
      const messages = [...snapTurn("s1", prose(500, "old")), ...snapTurn("s2", prose(500, "new"))];
      const secondRun = makeManager(clock, {}, path);
      expect(await run(secondRun, messages)).toEqual(messages);
      expect(secondRun.getPendingRewriteBoundaryMessage()).toBe(messages[1]);

      // A different session in the same process has never made a request: cold.
      const other = makeManager(clock, {}, `/tmp/rewrite-gate-${name}/session-b/transcript.jsonl`);
      expect(resultTexts(await run(other, messages))[0]).toContain("collapsed");
    });

    test("a session without a transcript shares warmth by session id", async () => {
      const clock = { now: 1_000_000 };
      const messages = [...snapTurn("s1", prose(500, "old")), ...snapTurn("s2", prose(500, "new"))];
      const firstRun = makeManager(clock);
      firstRun.setPromptCacheSessionKey(`ephemeral-${name}`);
      firstRun.noteModelRequestCompleted();

      clock.now += 20_000;
      const secondRun = makeManager(clock);
      secondRun.setPromptCacheSessionKey(`ephemeral-${name}`);
      expect(await run(secondRun, messages)).toEqual(messages);
      expect(secondRun.getPendingRewriteBoundaryMessage()).toBe(messages[1]);

      // Another non-persistent session has never made a request: cold.
      const other = makeManager(clock);
      other.setPromptCacheSessionKey(`ephemeral-${name}-other`);
      expect(resultTexts(await run(other, messages))[0]).toContain("collapsed");
      // And without any key a new instance is cold at every run start.
      expect(resultTexts(await run(makeManager(clock), messages))[0]).toContain("collapsed");
    });

    test("the session key is set late or alongside a transcript path", async () => {
      const clock = { now: 1_000_000 };
      const messages = [...snapTurn("s1", prose(500, "old")), ...snapTurn("s2", prose(500, "new"))];
      // A request noted before the key is known is published once it is set.
      const firstRun = makeManager(clock);
      firstRun.noteModelRequestCompleted();
      firstRun.setPromptCacheSessionKey(`late-${name}`);
      const secondRun = makeManager(clock);
      secondRun.setPromptCacheSessionKey(`late-${name}`);
      expect(await run(secondRun, messages)).toEqual(messages);

      // The transcript path wins: a session id never makes a cold transcript warm.
      const persistent = makeManager(clock, {}, `/tmp/rewrite-gate-${name}/session-c/t.jsonl`);
      persistent.setPromptCacheSessionKey(`late-${name}`);
      expect(resultTexts(await run(persistent, messages))[0]).toContain("collapsed");
    });

    test("explicit timestamp is honoured by noteModelRequestCompleted", async () => {
      const clock = { now: 100 * MINUTE };
      const cm = makeManager(clock);
      cm.noteModelRequestCompleted(clock.now - 31 * MINUTE);
      const messages = [...snapTurn("s1", prose(500, "old")), ...snapTurn("s2", prose(500, "new"))];
      expect(resultTexts(await run(cm, messages))[0]).toContain("collapsed");
    });
  });
}
