import { describe, expect, test } from "bun:test";
import { foldTranscript } from "../automation/foldTranscript";
import { mergeHistoryWindows } from "./mergeHistoryWindows";
import type { Message } from "../types";

describe("merging saved and canonical history windows", () => {
  test("keeps a saved prefix anchored by a durable user intent and preserves the new tail", () => {
    const disk = foldTranscript([
      { kind: "user", text: "Continue", clientMessageId: "intent", timestamp: 2 },
    ]);
    const saved = foldTranscript([
      { kind: "user", text: "Legacy-only history", timestamp: 1 },
      { kind: "user", text: "Continue", clientMessageId: "intent", timestamp: 3 },
      { kind: "user", text: "Unflushed tail", clientMessageId: "new", timestamp: 4 },
    ]);
    expect(mergeHistoryWindows(disk, saved).messages).toMatchObject([
      { text: "Legacy-only history" },
      { text: "Continue" },
      { text: "Unflushed tail" },
    ]);
  });

  test("uses timestamp and content for a legacy message without a submit id", () => {
    const disk = foldTranscript([{ kind: "user", text: "Recent", timestamp: 2 }]);
    const saved = foldTranscript([
      { kind: "user", text: "Older", timestamp: 1 },
      { kind: "user", text: "Recent", timestamp: 2 },
    ]);
    expect(mergeHistoryWindows(disk, saved).messages).toMatchObject([
      { text: "Older" },
      { text: "Recent" },
    ]);
  });

  test("does not guess a prefix from repeated text with different timestamps", () => {
    const disk = foldTranscript([{ kind: "user", text: "Continue", timestamp: 5 }]);
    const saved = foldTranscript([
      { kind: "user", text: "Older unrelated turn", timestamp: 1 },
      { kind: "user", text: "Continue", timestamp: 2 },
    ]);
    expect(mergeHistoryWindows(disk, saved).messages).toMatchObject([
      { text: "Continue", createdAt: 5 },
    ]);
  });
});

function snapshot(messages: Message[]) {
  return { ...foldTranscript([]), messages };
}
function question(id: string, intent: string | undefined, text = "Continue"): Message {
  return { kind: "user", id, text, ...(intent ? { clientMessageId: intent } : {}) };
}
function reply(id: string, text = "Recovered reply", done = true): Message {
  return { kind: "assistant", id, text, done };
}

describe("cached interrupted replies between durable user intents", () => {
  test("retains the released app's interrupted reply after a later turn and another restart", () => {
    const intent = "b118b84e-1b22-4293-80a5-44c14bf65adc";
    const nextIntent = "c939b6f1-84e0-46fc-a2a0-42690d3c87d7";
    const interrupted = reply(
      "assistant_tmtx7d0xx-nnxn",
      "验证回复 RV-CHAT-QUIT-FLUSH：开头｜中段｜结束。",
      false,
    );
    const initialDisk = snapshot([question("disk-quit", intent, "RV-CHAT-QUIT-FLUSH")]);
    const initialSaved = snapshot([
      question("saved-quit", intent, "RV-CHAT-QUIT-FLUSH"),
      interrupted,
    ]);
    const firstRestart = mergeHistoryWindows(initialDisk, initialSaved);
    expect(firstRestart.messages).toHaveLength(2);
    const nextQuestion = question("disk-next", nextIntent, "RV-CHAT-GENERATION-02");
    const nextReply = reply(
      "disk-next-reply",
      "验证回复 RV-CHAT-GENERATION-02：开头｜中段｜结束。",
    );
    const disk = snapshot([...initialDisk.messages, nextQuestion, nextReply]);
    const saved = snapshot([...firstRestart.messages, nextQuestion, nextReply]);
    const secondRestart = mergeHistoryWindows(disk, saved);
    expect(secondRestart.messages).toEqual([
      initialDisk.messages[0],
      interrupted,
      nextQuestion,
      nextReply,
    ]);
    expect(mergeHistoryWindows(disk, secondRestart).messages).toEqual(secondRestart.messages);
  });

  test.each(["clientMessageId", "steerId"] as const)(
    "keeps identical adjacent replies in their distinct %s turns",
    (identity) => {
      const users = ["one", "two", "three"].map((id) => ({
        kind: "user" as const,
        id: `disk-${id}`,
        text: "Continue",
        [identity]: id,
      }));
      const disk = snapshot([...users, reply("final", "Same reply")]);
      const saved = snapshot([
        { ...users[0]!, id: "saved-one" },
        reply("first", "Same reply"),
        { ...users[1]!, id: "saved-two" },
        reply("second", "Same reply"),
        { ...users[2]!, id: "saved-three" },
        reply("saved-final", "Same reply"),
      ]);
      expect(mergeHistoryWindows(disk, saved).messages.map((m) => m.id)).toEqual([
        "disk-one",
        "first",
        "disk-two",
        "second",
        "disk-three",
        "final",
      ]);
    },
  );

  test("does not revive a partial reply when canonical contains a final answer", () => {
    const disk = snapshot([
      question("d-one", "one"),
      reply("final", "Complete canonical answer"),
      question("d-two", "two"),
    ]);
    const saved = snapshot([
      question("s-one", "one"),
      reply("partial", "Complete", false),
      question("s-two", "two"),
    ]);
    expect(mergeHistoryWindows(disk, saved).messages).toEqual(disk.messages);
  });

  test("restores only the assistant, without reviving cached task or tool cards", () => {
    const disk = snapshot([question("d-one", "one"), question("d-two", "two"), reply("final")]);
    const recovered = reply("interrupted");
    const saved = snapshot([
      question("s-one", "one"),
      { kind: "task_list", id: "old-tasks", tasks: [] },
      { kind: "tool", id: "old-tool", toolName: "Read", args: "{}", status: "ok", startedAt: 0 },
      recovered,
      question("s-two", "two"),
      reply("s-final"),
    ]);
    expect(mergeHistoryWindows(disk, saved).messages).toEqual([
      disk.messages[0],
      recovered,
      ...disk.messages.slice(1),
    ]);
  });

  test.each(["missing", "different", "duplicate-saved", "duplicate-disk"] as const)(
    "does not infer an interior reply from %s intent identity",
    (variant) => {
      const disk = snapshot([
        question("d-one", variant === "missing" ? undefined : "one"),
        question("d-two", "two"),
        reply("d-final"),
      ]);
      const saved = snapshot([
        question(
          "s-one",
          variant === "missing" ? undefined : variant === "different" ? "other" : "one",
        ),
        reply("unproven"),
        question("s-two", "two"),
        reply("s-final"),
      ]);
      if (variant === "duplicate-saved") saved.messages.unshift(question("duplicate", "one"));
      if (variant === "duplicate-disk") disk.messages.unshift(question("duplicate", "one"));
      expect(mergeHistoryWindows(disk, saved).messages.some((m) => m.id === "unproven")).toBe(
        false,
      );
    },
  );

  test("keeps recovered replies around durable tool anchors and before a stop marker", () => {
    const tool: Message = {
      kind: "tool",
      id: "shared-call",
      toolName: "Read",
      args: "{}",
      status: "ok",
      startedAt: 0,
    };
    const stopped: Message = { kind: "turn_end", id: "stopped", reason: "stopped" };
    const disk = snapshot([
      question("d-one", "one"),
      tool,
      stopped,
      question("d-two", "two"),
      reply("final"),
    ]);
    const beforeTool = reply("before-tool", "Working", false);
    const afterTool = reply("after-tool", "Tool finished", false);
    const saved = snapshot([
      question("s-one", "one"),
      beforeTool,
      { ...tool },
      afterTool,
      question("s-two", "two"),
      reply("s-final"),
    ]);
    expect(mergeHistoryWindows(disk, saved).messages).toEqual([
      disk.messages[0],
      beforeTool,
      tool,
      afterTool,
      stopped,
      ...disk.messages.slice(3),
    ]);
  });

  test("does not fill history deliberately removed by a canonical compaction boundary", () => {
    const disk = snapshot([
      question("d-one", "one"),
      { kind: "context_boundary", id: "compacted", strategy: "compacted", before: 200, after: 100 },
      question("d-two", "two"),
      reply("final"),
    ]);
    const saved = snapshot([
      question("s-one", "one"),
      reply("compacted-old-answer"),
      question("s-two", "two"),
      reply("s-final"),
    ]);
    expect(mergeHistoryWindows(disk, saved).messages).toEqual(disk.messages);
  });

  test("keeps agent indices aligned after restoring both a prefix and an interior reply", () => {
    const agent: Message = {
      kind: "agent",
      id: "agent-one",
      description: "Retained agent",
      done: false,
      startedAt: 0,
      toolCalls: [],
      textBuffer: "",
      toolCount: 0,
    };
    const disk = {
      ...snapshot([question("d-one", "one"), agent, question("d-two", "two"), reply("final")]),
      agentMessageIndex: { "agent-one": 1 },
    };
    const saved = snapshot([
      question("prefix", "earlier"),
      reply("prefix-reply"),
      question("s-one", "one"),
      reply("recovered"),
      { ...agent },
      question("s-two", "two"),
      reply("s-final"),
    ]);
    const merged = mergeHistoryWindows(disk, saved);
    expect(merged.messages.map((message) => message.id)).toEqual([
      "prefix",
      "prefix-reply",
      "d-one",
      "recovered",
      "agent-one",
      "d-two",
      "final",
    ]);
    expect(merged.agentMessageIndex["agent-one"]).toBe(4);
    const refolded = {
      ...disk,
      messages: disk.messages.map((message) =>
        message.kind === "agent" ? message : { ...message, id: `refolded-${message.id}` },
      ),
    };
    const reopened = mergeHistoryWindows(refolded, merged);
    expect(reopened.agentMessageIndex["agent-one"]).toBe(4);
    expect(reopened.messages.filter((message) => message.id === "recovered")).toHaveLength(1);
  });
});
