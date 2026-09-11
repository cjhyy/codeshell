import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionTranscriptCache } from "./session-transcript-cache";

const fixtures: string[] = [];
const key = { projectKey: "investment.project", sessionId: "codex.session.1" };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codeshell-transcript-cache-"));
  fixtures.push(root);
  const directory = join(root, "current");
  const legacyDirectory = join(root, "legacy");
  return {
    directory,
    legacyDirectory,
    cache: new SessionTranscriptCache({ directory, legacyDirectory }),
  };
}
function message(id: string, kind = "assistant", text = id) {
  return { id, kind, text };
}
function state(
  messages: Record<string, unknown>[] = [message("a")],
  extra: Record<string, unknown> = {},
) {
  return JSON.stringify({ messages, snapshotSeq: 4, activeGoal: { goalId: "goal-1" }, ...extra });
}
afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SessionTranscriptCache", () => {
  test("backs up original legacy JSON once and never overwrites a newer projection", async () => {
    const { directory, legacyDirectory, cache } = fixture();
    const original = `  ${state([message("a"), message("b")])}\n`;
    await cache.write({ ...key, value: original, legacy: true });
    const backup = join(legacyDirectory, readdirSync(legacyDirectory)[0]);
    expect(readFileSync(backup, "utf8")).toBe(original);
    await cache.write({
      ...key,
      value: state([message("b", "assistant", "updated"), message("c")]),
    });
    await cache.write({ ...key, value: state([message("old")]), legacy: true });
    const restarted = new SessionTranscriptCache({ directory, legacyDirectory });
    const loaded = JSON.parse((await restarted.read(key)).value!);
    expect(loaded.messages.map((row: { id: string }) => row.id)).toEqual(["a", "b", "c"]);
    expect(loaded.messages[1].text).toBe("updated");
    expect(readFileSync(backup, "utf8")).toBe(original);
  });

  test("reads a bounded tail while retaining a single large message and fixing pointers", async () => {
    const { cache } = fixture();
    await cache.write({
      ...key,
      value: state(
        [
          message("old", "thinking", "x".repeat(1000)),
          message("worker", "agent"),
          message("answer", "assistant", "y".repeat(200)),
        ],
        {
          streamingAssistantId: "answer",
          streamingThinkingId: "old",
          agentMessageIndex: { worker: 1, missing: 99 },
        },
      ),
    });
    const tail = await cache.read({ ...key, maxBytes: 700 });
    expect(tail.hasEarlier).toBe(true);
    const parsed = JSON.parse(tail.value!);
    expect(parsed.messages.map((row: { id: string }) => row.id)).toEqual(["worker", "answer"]);
    expect(parsed.agentMessageIndex).toEqual({ worker: 0 });
    expect(parsed.streamingAssistantId).toBe("answer");
    expect(parsed.streamingThinkingId).toBeNull();
    expect(parsed.activeGoal).toEqual({ goalId: "goal-1" });
    expect(parsed.snapshotSeq).toBe(4);
    const tiny = await cache.read({ ...key, maxBytes: 1 });
    expect(JSON.parse(tiny.value!).messages.map((row: { id: string }) => row.id)).toEqual([
      "answer",
    ]);
    expect(tiny.hasEarlier).toBe(true);
    const all = await cache.read({ ...key, maxBytes: Number.MAX_SAFE_INTEGER });
    expect(all.hasEarlier).toBe(false);
    expect(JSON.parse(all.value!).messages).toHaveLength(3);
    await cache.write({ ...key, value: tail.value! });
    expect(
      JSON.parse((await cache.read({ ...key, maxBytes: Number.MAX_SAFE_INTEGER })).value!).messages,
    ).toHaveLength(3);
  });

  test("serializes writes and isolates projects with dotted ids", async () => {
    const { cache } = fixture();
    const pending = [
      cache.write({ ...key, value: state([message("a")]) }),
      cache.write({ ...key, value: state([message("a"), message("b")]) }),
      cache.write({
        projectKey: "investment",
        sessionId: "project.codex.session.1",
        value: state([message("other")]),
      }),
    ];
    await cache.flush();
    await Promise.all(pending);
    expect(JSON.parse((await cache.read(key)).value!).messages).toHaveLength(2);
    expect(
      JSON.parse(
        (await cache.read({ projectKey: "investment", sessionId: "project.codex.session.1" }))
          .value!,
      ).messages[0].id,
    ).toBe("other");
  });

  test("replaces a full random-id disk fold without duplicating the same history", async () => {
    const { cache } = fixture();
    const firstFold = [
      message("user-a", "user", "look at this fund"),
      message("answer-a", "assistant", "analysis"),
    ];
    await cache.write({ ...key, value: state(firstFold) });
    const secondFold = [
      message("user-b", "user", "look at this fund"),
      message("answer-b", "assistant", "analysis"),
    ];
    await cache.write({ ...key, value: state(secondFold) });
    await cache.write({ ...key, value: state(secondFold) });
    expect(JSON.parse((await cache.read(key)).value!).messages).toEqual(secondFold);
  });

  test("keeps earlier pages across random-id tails and distinct repeated user intents", async () => {
    const { cache } = fixture();
    const first = { ...message("user-a", "user", "continue"), clientMessageId: "intent-a" };
    const second = { ...message("user-b", "user", "continue"), clientMessageId: "intent-b" };
    await cache.write({
      ...key,
      value: state([first, message("answer-a", "assistant", "same answer")]),
    });
    await cache.write({
      ...key,
      value: state([second, message("answer-b", "assistant", "same answer")]),
    });
    let all = JSON.parse((await cache.read(key)).value!);
    expect(all.messages).toHaveLength(4);
    const reFoldedTail = [
      { ...second, id: "random-new-user" },
      message("random-new-answer", "assistant", "same answer"),
    ];
    await cache.write({ ...key, value: state(reFoldedTail) });
    all = JSON.parse((await cache.read(key)).value!);
    expect(all.messages).toEqual([
      first,
      message("answer-a", "assistant", "same answer"),
      ...reFoldedTail,
    ]);
    await cache.write({
      ...key,
      value: state([message("random-tail", "assistant", "same answer")]),
    });
    expect(JSON.parse((await cache.read(key)).value!).messages).toHaveLength(4);
  });

  test("a delayed second window cannot erase a completed reply or subsequent legacy-only turns", async () => {
    const { directory, legacyDirectory, cache } = fixture();
    const secondWindow = new SessionTranscriptCache({ directory, legacyDirectory });
    const firstUser = {
      ...message("user-1", "user", "fund forecast"),
      clientMessageId: "intent-1",
    };
    const secondUser = { ...message("user-2", "user", "continue"), clientMessageId: "intent-2" };
    const unfinished = { ...message("answer-1", "assistant", "The fund"), done: false };
    await cache.write({
      ...key,
      value: state([firstUser, unfinished], { sessionId: null, snapshotSeq: 0 }),
    });
    const oldSnapshot = (await secondWindow.read({ ...key, maxBytes: Number.MAX_SAFE_INTEGER }))
      .value!;
    const completed = {
      ...message("answer-1", "assistant", "The fund may fluctuate in the coming week."),
      done: true,
    };
    const continuation = {
      ...message("answer-2", "assistant", "Here are the later changes."),
      done: true,
    };
    await cache.write({
      ...key,
      value: state([firstUser, completed, secondUser, continuation], {
        sessionId: null,
        snapshotSeq: 0,
      }),
    });
    await secondWindow.write({ ...key, value: oldSnapshot });
    const loaded = JSON.parse((await cache.read(key)).value!);
    expect(loaded.messages).toEqual([firstUser, completed, secondUser, continuation]);
    expect(loaded.streamingAssistantId).toBeNull();
  });

  test("a new Main epoch resets the cached cursor instead of inheriting an older high sequence", async () => {
    const { cache } = fixture();
    await cache.write({
      ...key,
      value: state([message("answer")], { snapshotEpoch: "old", snapshotSeq: 500 }),
    });
    await cache.write({
      ...key,
      value: state([message("answer")], { snapshotEpoch: "new", snapshotSeq: 3 }),
    });
    expect(JSON.parse((await cache.read(key)).value!)).toMatchObject({
      snapshotEpoch: "new",
      snapshotSeq: 3,
    });
    await cache.write({ ...key, value: state([], { snapshotEpoch: "new", snapshotSeq: 2 }) });
    expect(JSON.parse((await cache.read(key)).value!)).toMatchObject({
      snapshotEpoch: "new",
      snapshotSeq: 3,
    });
    await cache.write({ ...key, value: state([message("answer")], { snapshotSeq: 1 }) });
    expect(JSON.parse((await cache.read(key)).value!).snapshotEpoch).toBeUndefined();
  });

  test("expanding a saved tail prepends older messages before the known suffix", async () => {
    const { cache } = fixture();
    const older = {
      ...message("older", "user", "previous question"),
      clientMessageId: "old-intent",
    };
    const question = {
      ...message("question", "user", "recent question"),
      clientMessageId: "current-intent",
    };
    const answer = message("answer", "assistant", "recent answer");
    await cache.write({ ...key, value: state([question, answer]) });
    await cache.write({ ...key, value: state([older, question, answer]) });
    expect(JSON.parse((await cache.read(key)).value!).messages).toEqual([older, question, answer]);
  });

  test("a repeated first answer cannot outrank the later stable anchor of an expanded page", async () => {
    const { cache } = fixture();
    const question = { ...message("current-user", "user", "question"), clientMessageId: "current" };
    const answer = message("current-answer", "assistant", "same answer");
    const olderAnswer = message("older-answer", "assistant", "same answer");
    await cache.write({ ...key, value: state([question, answer]) });
    await cache.write({ ...key, value: state([olderAnswer, question, answer]) });
    expect(JSON.parse((await cache.read(key)).value!).messages).toEqual([
      olderAnswer,
      question,
      answer,
    ]);
  });

  test.each(["stable", "refold-with-intent", "legacy-refold"])(
    "expanding %s history is ordered, idempotent, and retains another window's newer suffix",
    async (mode) => {
      const { cache } = fixture();
      const ordered = [
        message("u1", "user", "older question"),
        message("a1", "assistant", "older answer"),
        message("u2", "user", "recent question"),
        message("a2", "assistant", "recent answer"),
        message("u3", "user", "latest question"),
        message("a3", "assistant", "latest answer"),
      ].map((row) =>
        row.kind === "user" && mode !== "legacy-refold" ? { ...row, clientMessageId: row.id } : row,
      );
      await cache.write({ ...key, value: state(ordered.slice(2)) });
      const expanded = ordered
        .slice(0, 4)
        .map((row) => (mode === "stable" ? row : { ...row, id: `refold-${row.id}` }));
      await cache.write({ ...key, value: state(expanded) });
      const first = JSON.parse((await cache.read(key)).value!).messages;
      expect(first.map((row: { text: string }) => row.text)).toEqual(
        ordered.map((row) => row.text),
      );
      await cache.write({ ...key, value: state(expanded) });
      expect(JSON.parse((await cache.read(key)).value!).messages).toEqual(first);
    },
  );

  test("a refolded unfinished reply keeps its streaming pointer attached to the merged id", async () => {
    const { cache } = fixture();
    const question = { ...message("u", "user", "question"), clientMessageId: "intent" };
    await cache.write({
      ...key,
      value: state(
        [question, { ...message("live", "assistant", "Part and live tail"), done: false }],
        { streamingAssistantId: "live" },
      ),
    });
    await cache.write({
      ...key,
      value: state(
        [
          { ...question, id: "refold-user" },
          { ...message("refold-answer", "assistant", "Part"), done: false },
        ],
        { streamingAssistantId: null },
      ),
    });
    const saved = JSON.parse((await cache.read(key)).value!);
    expect(saved.messages[1]).toMatchObject({
      id: "refold-answer",
      text: "Part and live tail",
      done: false,
    });
    expect(saved.streamingAssistantId).toBe("refold-answer");
  });

  test("a stale high-sequence snapshot cannot regress done text, while genuine completion advances it", async () => {
    const { cache } = fixture();
    const user = { ...message("user", "user", "question"), steerId: "durable-steer" };
    await cache.write({
      ...key,
      value: state([user, { ...message("answer", "assistant", "Part"), done: false }], {
        snapshotSeq: 100,
        streamingAssistantId: "answer",
      }),
    });
    await cache.write({
      ...key,
      value: state(
        [user, { ...message("answer", "assistant", "Part one and part two."), done: true }],
        { snapshotSeq: 0, streamingAssistantId: null },
      ),
    });
    await cache.write({
      ...key,
      value: state([user, { ...message("answer", "assistant", "Part"), done: false }], {
        snapshotSeq: 1000,
        streamingAssistantId: "answer",
      }),
    });
    const loaded = JSON.parse((await cache.read(key)).value!);
    expect(loaded.messages[1]).toMatchObject({ text: "Part one and part two.", done: true });
    expect(loaded.messages).toHaveLength(2);
    expect(loaded.streamingAssistantId).toBeNull();
  });

  test("random-id old folds preserve newer tail and merge progress after a durable user anchor", async () => {
    const { cache } = fixture();
    const user = { ...message("live-user", "user", "question"), clientMessageId: "intent" };
    const done = { ...message("live-answer", "assistant", "Answer with all details"), done: true };
    const laterUser = { ...message("later-user", "user", "next"), clientMessageId: "later-intent" };
    await cache.write({ ...key, value: state([user, done, laterUser, message("later-answer")]) });
    await cache.write({
      ...key,
      value: state([
        { ...user, id: "fold-user" },
        { ...message("fold-answer", "assistant", "Answer"), done: false },
      ]),
    });
    const loaded = JSON.parse((await cache.read(key)).value!);
    expect(loaded.messages).toHaveLength(4);
    expect(loaded.messages[1]).toMatchObject({
      id: "fold-answer",
      text: "Answer with all details",
      done: true,
    });
    expect(loaded.messages[2]).toEqual(laterUser);
    expect(loaded.messages[3].id).toBe("later-answer");
  });

  test("merges a distinct new window intent after the existing continuation and keeps terminal tools", async () => {
    const { cache } = fixture();
    const first = { ...message("u1", "user", "continue"), clientMessageId: "one" };
    const second = { ...message("u2", "user", "continue"), clientMessageId: "two" };
    const third = { ...message("u3", "user", "continue"), clientMessageId: "three" };
    const completedTool = {
      id: "tool",
      kind: "tool",
      toolName: "Read",
      args: "{}",
      status: "succeeded",
      result: "full result",
    };
    await cache.write({ ...key, value: state([first, completedTool, second, message("a2")]) });
    await cache.write({
      ...key,
      value: state([
        first,
        { ...completedTool, status: "running", result: "" },
        third,
        message("a3"),
      ]),
    });
    const loaded = JSON.parse((await cache.read(key)).value!);
    expect(loaded.messages.map((row: { id: string }) => row.id)).toEqual([
      "u1",
      "tool",
      "u2",
      "a2",
      "u3",
      "a3",
    ]);
    expect(loaded.messages[1]).toMatchObject({ status: "succeeded", result: "full result" });
  });

  test("deletion removes sensitive snapshots and fences delayed writes and reimports", async () => {
    const { legacyDirectory, cache } = fixture();
    await cache.write({ ...key, value: state(), legacy: true });
    await cache.delete(key);
    expect(readdirSync(legacyDirectory)).toEqual([]);
    await cache.write({ ...key, value: state([message("late")]) });
    await cache.write({ ...key, value: state(), legacy: true });
    expect(await cache.read(key)).toEqual({ value: null, hasEarlier: false });
    expect(readdirSync(legacyDirectory)).toEqual([]);
  });

  test("rejects failed writes without corrupting a snapshot or poisoning the queue", async () => {
    const { directory, cache } = fixture();
    await cache.write({ ...key, value: state() });
    const file = join(directory, readdirSync(directory)[0]);
    const committed = readFileSync(file, "utf8");
    rmSync(file);
    mkdirSync(file);
    await expect(cache.write({ ...key, value: state([message("failed")]) })).rejects.toThrow();
    rmSync(file, { recursive: true });
    writeFileSync(file, committed);
    expect(JSON.parse((await cache.read(key)).value!).messages[0].id).toBe("a");
    await cache.write({ ...key, value: state([message("a", "assistant", "recovered")]) });
    expect(JSON.parse((await cache.read(key)).value!).messages[0].text).toBe("recovered");
  });

  test("validates ids, JSON and message arrays at the main boundary", async () => {
    const { cache } = fixture();
    for (const sessionId of [
      "../outside",
      "__proto__",
      "constructor",
      "prototype",
      "a/b",
      "a\\b",
    ]) {
      await expect(cache.write({ ...key, sessionId, value: state() })).rejects.toThrow();
    }
    for (const value of [
      "{broken",
      "{}",
      '{"messages":{}}',
      '{"messages":[null]}',
      '{"messages":[{"id":"a"}]}',
      '{"messages":[],"__proto__":{}}',
    ]) {
      await expect(cache.write({ ...key, value })).rejects.toThrow();
    }
    await expect(cache.read({ ...key, maxBytes: -1 })).rejects.toThrow();
    expect(await cache.read(key)).toEqual({ value: null, hasEarlier: false });
  });
});
