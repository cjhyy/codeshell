import { describe, expect, test } from "bun:test";
import {
  buildStreamItems,
  processGroupActivityLabel,
  processGroupLabel,
  reconcileStreamItems,
  toolGroupActivityLabel,
  type ToolGroup,
  type TurnProcessGroup,
} from "./streamGroups";
import type { AgentMessage, AssistantMessage, Message, ThinkingMessage, ToolMessage } from "../types";

let idCounter = 0;
function freshId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function user(text = "hi", createdAt?: number): Message {
  return { kind: "user", id: freshId("user"), text, createdAt };
}

/** An engine-injected user turn (steer / goal wakeup / cron续接) — carries
 *  injected:true. Such a message must NOT open a new turn boundary. */
function injectedUser(text = "steer", createdAt?: number, steerId?: string): Message {
  return { kind: "user", id: freshId("user"), text, createdAt, injected: true, steerId };
}

/** A still-streaming assistant message (done:false) — the turn hasn't finalized,
 *  so a live turn stays isLive until turn_complete. */
function streamingAssistant(text: string, createdAt?: number): AssistantMessage {
  return { kind: "assistant", id: freshId("assistant"), text, done: false, createdAt };
}

function assistant(
  text: string,
  times: { createdAt?: number; doneAt?: number } = {},
): AssistantMessage {
  return { kind: "assistant", id: freshId("assistant"), text, done: true, ...times };
}

function thinking(text = "thinking"): ThinkingMessage {
  return { kind: "thinking", id: freshId("thinking"), text, done: true };
}

function tool(
  toolName = "Read",
  startedAt = 1,
  endedAt = startedAt + 5,
  args: Record<string, unknown> = {},
): ToolMessage {
  return {
    kind: "tool",
    id: freshId("tool"),
    toolName,
    args: JSON.stringify(args),
    result: "ok",
    status: "succeeded",
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
  };
}

function agent(id: string, toolCount: number, opts: { done?: boolean } = {}): AgentMessage {
  return {
    kind: "agent",
    id,
    description: "sub",
    done: opts.done ?? false,
    startedAt: 2,
    toolCalls: Array.from({ length: toolCount }, (_, i) => ({
      kind: "tool" as const,
      id: `${id}-t${i}`,
      toolName: "Read",
      args: "{}",
      status: "running" as const,
      startedAt: 2 + i,
    })),
    textBuffer: "",
    toolCount,
  };
}

function findAgentIn(items: ReturnType<typeof buildStreamItems>): AgentMessage | null {
  for (const it of items) {
    if (it.kind === "agent") return it;
    if (it.kind === "turn_process_group" || it.kind === "tool_group") {
      const f = findAgentIn(it.items as ReturnType<typeof buildStreamItems>);
      if (f) return f;
    }
  }
  return null;
}

function processGroups(items: ReturnType<typeof buildStreamItems>): TurnProcessGroup[] {
  return items.filter((item): item is TurnProcessGroup => item.kind === "turn_process_group");
}

function turnEnd(reason: "stopped" | "timeout" | "error" = "stopped"): Message {
  return { kind: "turn_end", id: freshId("turn-end"), reason };
}

describe("buildStreamItems — interrupted turn (stopped)", () => {
  // Screenshot bug: user interrupts a long turn (tools), then continues with a
  // new message. The FIRST (interrupted) turn must be marked stopped so it
  // renders flat, not behind the "已处理 Xs ⌄" fold header.
  test("an interrupted-then-continued turn keeps stopped=true", () => {
    const messages: Message[] = [
      user("do a long thing"),
      assistant("working…"),
      tool("Read", 1, 5),
      tool("Bash", 6, 9),
      turnEnd("stopped"), // user pressed Stop here
      user("actually just use the browser"), // continued in a new turn
      assistant("ok"),
      tool("browser_navigate", 20, 25),
    ];
    const items = buildStreamItems(messages);
    const groups = processGroups(items);
    // The interrupted turn's group is the first one; it must be stopped.
    expect(groups.length).toBeGreaterThanOrEqual(1);
    expect(groups[0]!.stopped).toBe(true);
  });

  test("turn_end stopped at the very tail (last turn) still marks that turn", () => {
    const messages: Message[] = [
      user("q"),
      assistant("a"),
      tool("Read", 1, 5),
      turnEnd("stopped"),
    ];
    const groups = processGroups(buildStreamItems(messages));
    expect(groups[0]!.stopped).toBe(true);
  });
});

describe("buildStreamItems", () => {
  test("wraps the whole turn (lead + middle text + tools) into one process card, but leaves the final summary outside", () => {
    const lead = assistant("我先查一下。");
    const middle = assistant("目录比较大，我继续读核心入口。");
    const final = assistant("总结如下。");
    const messages: Message[] = [
      user(),
      lead,
      tool("Glob", 10, 20),
      tool("Grep", 21, 30),
      tool("Read", 31, 40),
      middle,
      tool("Read", 50, 60),
      tool("Read", 61, 70),
      final,
    ];

    const items = buildStreamItems(messages);
    // One outer card spanning [lead .. last tool]; the final summary
    // text after the last tool stays inline outside the card.
    expect(items.map((item) => item.kind)).toEqual([
      "user",
      "turn_process_group",
      "assistant",
    ]);

    const groups = processGroups(items);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.toolCount).toBe(5);
    // The lead-in and the mid-run narration both live INSIDE the card.
    expect(groups[0]?.items.some((item) => item.kind === "assistant")).toBe(true);
    // The trailing summary is NOT inside the card.
    const last = items[items.length - 1];
    expect(last?.kind).toBe("assistant");
    if (last?.kind === "assistant") expect(last.text).toBe("总结如下。");
  });

  test("a trailing bookkeeping tool (UpdateAutomationMemory) does not swallow the report text before it", () => {
    // Real automation shape: search/fetch tools, then the report, then the
    // end-of-run UpdateAutomationMemory bookkeeping call. The report must
    // stay OUTSIDE the process card (visible), not folded into it.
    const report = assistant("## 每日美股晨报\n标普500 +0.30% …");
    const messages: Message[] = [
      user(),
      tool("WebSearch", 10, 20),
      tool("WebFetch", 21, 30),
      report,
      tool("UpdateAutomationMemory", 31, 40),
    ];

    const items = buildStreamItems(messages);
    // Card anchors on WebFetch (the last *real* tool); the report and the
    // bookkeeping tool both fall after it and render inline.
    const groups = processGroups(items);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.toolCount).toBe(2); // WebSearch + WebFetch only
    // The report is a top-level inline item, not buried in the card.
    const reportInline = items.some(
      (it) => it.kind === "assistant" && it.text.startsWith("## 每日美股晨报"),
    );
    expect(reportInline).toBe(true);
    // The card itself must NOT contain the report text.
    expect(
      groups[0]?.items.some(
        (it) => it.kind === "assistant" && it.text.startsWith("## 每日美股晨报"),
      ),
    ).toBe(false);
    // The bookkeeping tool still renders (it isn't hidden) — present somewhere.
    const hasBookkeeping = JSON.stringify(items).includes("UpdateAutomationMemory");
    expect(hasBookkeeping).toBe(true);
  });

  test("a turn whose ONLY tool is bookkeeping makes no process card", () => {
    const messages: Message[] = [
      user(),
      assistant("报告正文。"),
      tool("UpdateAutomationMemory", 10, 20),
    ];
    const items = buildStreamItems(messages);
    expect(processGroups(items)).toHaveLength(0);
    // Report text stays a visible top-level assistant message.
    expect(items.some((it) => it.kind === "assistant" && it.text === "报告正文。")).toBe(true);
  });

  test("inside the outer card, adjacent tools fold into a tool_group but assistant text splits them", () => {
    const messages: Message[] = [
      user(),
      tool("Glob", 10, 20),
      tool("Grep", 21, 30),
      assistant("中间说明。"),
      tool("Read", 50, 60),
      tool("Read", 61, 70),
      assistant("结束。"),
    ];

    const groups = processGroups(buildStreamItems(messages));
    expect(groups).toHaveLength(1);
    // Outer card holds: [tool_group(2), assistant, tool_group(2)].
    const inner = groups[0]!.items;
    expect(inner.map((it) => it.kind)).toEqual([
      "tool_group",
      "assistant",
      "tool_group",
    ]);
  });

  test("keeps thinking transparent between adjacent tools", () => {
    const messages: Message[] = [
      user(),
      tool("Read", 10, 20),
      thinking(),
      tool("Grep", 21, 30),
    ];

    const groups = processGroups(buildStreamItems(messages));
    expect(groups).toHaveLength(1);
    expect(groups[0]?.toolCount).toBe(2);
    expect(groups[0]?.items).toHaveLength(1);
    const inner = groups[0]?.items[0];
    expect(inner?.kind).toBe("tool_group");
    if (inner?.kind === "tool_group") {
      expect(inner.items.map((item) => item.kind)).toEqual(["tool", "thinking", "tool"]);
    }
  });

  test("a purely conversational turn (no tools) renders inline, no empty process card", () => {
    const messages: Message[] = [user(), assistant("你好，这是回答。")];
    const items = buildStreamItems(messages);
    expect(items.map((it) => it.kind)).toEqual(["user", "assistant"]);
    expect(processGroups(items)).toHaveLength(0);
  });

  test("completed assistant message makes the last turn non-live even if the bucket busy flag is stale", () => {
    const messages: Message[] = [
      user("run", 0),
      tool("Bash", 1_000, 2_000),
      assistant("done", { createdAt: 500, doneAt: 3_000 }),
    ];

    const groups = processGroups(buildStreamItems(messages, { liveTurnActive: true }));

    expect(groups).toHaveLength(1);
    expect(groups[0]!.isLive).toBe(false);
    expect(groups[0]!.durationMs).toBe(3_000);
  });

  // 渐进插入(steer / goal wakeup / cron续接)注入一条 injected user 消息时,
  // 上一正在流的轮不能被折叠:injected 消息是"当前工作的延续",不开启新轮。
  test("an injected user message does NOT fold the prior in-flight live turn", () => {
    const messages: Message[] = [
      user("run the task", 0),
      streamingAssistant("working…", 100), // NOT done yet (streaming)
      tool("Bash", 1_000, 2_000),
      injectedUser("also check the logs", 2_500), // steer spliced in mid-turn
    ];

    const groups = processGroups(buildStreamItems(messages, { liveTurnActive: true }));

    // Exactly ONE turn group, and it stays live (not folded) — the injected
    // message did not become a new turn boundary demoting the prior turn.
    expect(groups).toHaveLength(1);
    expect(groups[0]!.isLive).toBe(true);
  });

  test("a consumed mid-turn steer stays in one live group after an intermediate assistant", () => {
    const messages: Message[] = [
      user("run", 0),
      assistant("I'll inspect first.", { createdAt: 100, doneAt: 500 }),
      tool("Read", 600, 900),
      injectedUser("also check tests", 1_000, "steer-1"),
      streamingAssistant("continuing…", 1_100),
    ];

    const groups = processGroups(buildStreamItems(messages, { liveTurnActive: true }));

    expect(groups).toHaveLength(1);
    expect(groups[0]!.isLive).toBe(true);
    expect(
      groups[0]!.items.some(
        (item) => item.kind === "user" && item.steerId === "steer-1",
      ),
    ).toBe(true);
    expect(
      groups[0]!.items.some(
        (item) => item.kind === "assistant" && item.text === "continuing…",
      ),
    ).toBe(true);
  });

  // Real wakeup form: the PRIOR turn already finished (assistant done + tool),
  // THEN a cron续接 / background-completion injects a user message and a NEW
  // assistant starts streaming. That new work must render live, not be folded
  // into the already-completed prior turn's "已处理 Xs" card.
  test("an injected wakeup after a COMPLETED turn opens a new live segment (not folded)", () => {
    const messages: Message[] = [
      user("run the task", 0),
      assistant("all done", { createdAt: 100, doneAt: 3_000 }), // prior turn finished
      tool("Bash", 1_000, 2_000),
      injectedUser("background job finished", 4_000), // wakeup spliced in
      streamingAssistant("picking up the result…", 4_100), // NEW work, still streaming
    ];

    const items = buildStreamItems(messages, { liveTurnActive: true });

    // The wakeup opens a NEW segment: the prior completed turn folds into its
    // own (non-live) card, and the new streaming assistant renders inline as a
    // top-level item — NOT swallowed into the prior turn's fold card.
    const priorCard = items.find((it) => it.kind === "turn_process_group") as TurnProcessGroup | undefined;
    expect(priorCard?.isLive).toBe(false);
    const streamingInline = items.some(
      (it) => it.kind === "assistant" && (it as { text?: string }).text === "picking up the result…",
    );
    expect(streamingInline).toBe(true);
  });

  test("a real (non-injected) new user turn DOES fold the prior completed turn (regression)", () => {
    const messages: Message[] = [
      user("first task", 0),
      tool("Bash", 1_000, 2_000),
      assistant("done", { createdAt: 500, doneAt: 3_000 }),
      user("second task", 4_000), // a genuine new turn
    ];

    const groups = processGroups(buildStreamItems(messages, { liveTurnActive: true }));

    // Prior turn is a normal closed/folded group; only the new turn is live.
    expect(groups.length).toBeGreaterThanOrEqual(1);
    expect(groups[0]!.isLive).toBe(false);
  });

  test("an injected user message's text is still present in the stream (not dropped)", () => {
    const messages: Message[] = [
      user("run the task", 0),
      assistant("working…", { createdAt: 100 }),
      tool("Bash", 1_000, 2_000),
      injectedUser("also check the logs", 2_500),
    ];

    const items = buildStreamItems(messages, { liveTurnActive: true });
    const hasInjectedBubble = items.some(
      (it) => it.kind === "user" && (it as { text?: string }).text === "also check the logs",
    );
    expect(hasInjectedBubble).toBe(true);
  });

  // A mid-turn steer while the turn is still streaming lands INSIDE the live
  // turn's process group (it's not a boundary). The group card must therefore
  // render user members — regression guard for the "steer bubble disappears
  // after it's actually consumed" bug: the injected user was a group member
  // but TurnProcessGroupCard had no `user` branch, so it hit `return null`.
  test("a mid-turn injected steer bubble is carried as a member of the live group", () => {
    const messages: Message[] = [
      user("run the task", 0),
      streamingAssistant("working…", 100), // still streaming → no boundary
      tool("Bash", 1_000, 2_000),
      injectedUser("also check the logs", 2_500), // steer spliced in mid-turn
    ];

    const groups = processGroups(buildStreamItems(messages, { liveTurnActive: true }));
    expect(groups).toHaveLength(1);
    // The steer bubble must live inside the (still live) group so the card can
    // draw it — otherwise the confirmed steer visibly vanishes from the chat.
    const insideGroup = groups[0]!.items.some(
      (it) => it.kind === "user" && (it as { text?: string }).text === "also check the logs",
    );
    expect(insideGroup).toBe(true);
  });

  // The interrupted turn should render flat, not behind "已处理 Xs ⌄". The
  // process group must carry stopped=true when a trailing turn_end
  // reason="stopped" sits in the turn slice, so the card drops its fold header.
  test("marks a turn stopped when it ends with turn_end reason=stopped", () => {
    const turnEnd: Message = { kind: "turn_end", id: "te-1", reason: "stopped", elapsedMs: 4_000 };
    const messages: Message[] = [
      user("do it", 0),
      tool("Bash", 1_000, 2_000),
      turnEnd,
    ];
    const groups = processGroups(buildStreamItems(messages));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.stopped).toBe(true);
    // The turn_end sibling stays OUTSIDE the group (rendered by TurnEndMessageView).
    expect(groups[0]!.items.some((it) => it.kind === "turn_end")).toBe(false);
  });

  test("a normally-completed turn is not marked stopped", () => {
    const messages: Message[] = [
      user("do it", 0),
      tool("Bash", 1_000, 2_000),
      assistant("done", { createdAt: 500, doneAt: 3_000 }),
    ];
    const groups = processGroups(buildStreamItems(messages));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.stopped).toBeFalsy();
  });
});

describe("activity labels", () => {
  test("process group label uses the latest concrete action instead of command count or duration", () => {
    const messages: Message[] = [
      user(),
      tool("Read", 10, 20, { file_path: "/repo/src/index.ts" }),
      tool("Grep", 21, 30, { pattern: "runner.permission" }),
    ];

    const groups = processGroups(buildStreamItems(messages));
    expect(processGroupActivityLabel(groups[0]!)).toBe("已搜索 runner.permission");
  });

  test("tool group label uses the latest concrete action", () => {
    const messages: Message[] = [
      user(),
      tool("Read", 10, 20, { file_path: "/repo/src/index.ts" }),
      tool("Bash", 21, 30, { command: "bun test streamGroups.test.ts" }),
    ];

    const groups = processGroups(buildStreamItems(messages));
    const inner = groups[0]!.items[0] as ToolGroup;
    expect(toolGroupActivityLabel(inner)).toBe("已运行 bun test streamGroups.test.ts");
  });
});

describe("turn process duration", () => {
  // Bug: the process card showed "已处理 0s" whenever the turn's tools each
  // completed near-instantly (e.g. a Skill that returns in 0ms, or fast local
  // reads). The card measured ONLY the tool-execution wall span, so a turn that
  // spent its real time inside the model produced 0s. The duration should
  // reflect the WHOLE turn — from when the user sent / the assistant began to
  // when the assistant finished (doneAt) — not just the tool span.

  test("uses the user→assistant span, not the (near-zero) tool span", () => {
    // Tools are instantaneous (startedAt === endedAt) but the model spent 8s.
    const messages: Message[] = [
      user("帮我查一下", 100_000),
      tool("Skill", 105_000, 105_000), // 0ms tool
      assistant("查完了。", { createdAt: 100_500, doneAt: 108_000 }),
    ];
    const groups = processGroups(buildStreamItems(messages));
    expect(groups).toHaveLength(1);
    // 108_000 − 100_000 = 8s, not 0s from the instant tool.
    expect(groups[0]!.durationMs).toBe(8_000);
    expect(processGroupLabel(groups[0]!.durationMs)).toBe("已处理 8s");
  });

  test("falls back to the tool span when no turn timestamps are present", () => {
    // Replayed/historical transcripts carry no createdAt/doneAt — keep the
    // existing tool-span behavior so we don't regress those.
    const messages: Message[] = [user(), tool("Read", 1_000, 6_000)];
    const groups = processGroups(buildStreamItems(messages));
    expect(groups[0]!.durationMs).toBe(5_000);
  });

  test("takes the wider of turn span and tool span", () => {
    // Defensive: if a tool somehow ran past the recorded doneAt, don't shrink
    // the reported duration below the real tool wall time.
    const messages: Message[] = [
      user("go", 0),
      tool("Bash", 1_000, 12_000), // 12s tool
      assistant("done", { createdAt: 0, doneAt: 5_000 }), // only 5s turn stamp
    ];
    const groups = processGroups(buildStreamItems(messages));
    expect(groups[0]!.durationMs).toBe(12_000);
  });
});

describe("reconcileStreamItems", () => {
  test("reuses the previous group object when content is unchanged", () => {
    // Same message objects (same ids) folded twice — mirrors the app, where
    // a 50ms batch hands the SAME stable reducer messages back to the fold.
    // buildStreamItems allocates fresh group wrappers each call; reconcile
    // should hand back the previous render's wrapper so React.memo skips it.
    const msgs: Message[] = [user(), tool("Read", 10, 15), tool("Grep", 16, 20)];
    const prev = buildStreamItems(msgs);
    const next = buildStreamItems(msgs);
    const reconciled = reconcileStreamItems(prev, next);
    const prevGroup = prev.find((i) => i.kind === "turn_process_group");
    const recGroup = reconciled.find((i) => i.kind === "turn_process_group");
    expect(recGroup).toBe(prevGroup);
  });

  test("returns a fresh group object when the group content changes", () => {
    const base: Message[] = [user(), tool("Read", 10, 15), tool("Grep", 16, 20)];
    const prev = buildStreamItems(base);
    // A new tool appended this turn → different signature → no reuse.
    const next = buildStreamItems([...base, tool("Read", 21, 25)]);
    const reconciled = reconcileStreamItems(prev, next);
    const prevGroup = prev.find((i) => i.kind === "turn_process_group");
    const recGroup = reconciled.find((i) => i.kind === "turn_process_group");
    expect(recGroup).not.toBe(prevGroup);
  });

  test("does NOT reuse a stale group when an inner agent message mutates in place", () => {
    // A live turn containing a subagent. The agent's id is stable while its
    // toolCalls/toolCount grow as it runs. Keying the group signature only on
    // inner ids would reuse the previous (stale) group object and freeze the
    // subagent card. The signature must reflect the agent's mutable shape.
    const u = user();
    const t = tool("Bash", 1, 2);
    const built1 = buildStreamItems([u, t, agent("a1", 1)], { liveTurnActive: true });
    const recon1 = reconcileStreamItems([], built1);
    const built2 = buildStreamItems([u, t, agent("a1", 2)], { liveTurnActive: true });
    const recon2 = reconcileStreamItems(recon1, built2);
    expect(findAgentIn(recon2)?.toolCount).toBe(2);

    // Flipping to done is also a content change the card must observe.
    const built3 = buildStreamItems([u, t, agent("a1", 2, { done: true })], { liveTurnActive: true });
    const recon3 = reconcileStreamItems(recon2, built3);
    expect(findAgentIn(recon3)?.done).toBe(true);
  });

  // An in-group steer bubble flips pending→confirmed in place (same id). The
  // group signature MUST change so the memoized card re-renders — otherwise the
  // card stays frozen at the pending render and the confirmed bubble (which
  // TurnProcessGroupCard only draws once pending is false) never appears.
  test("does NOT reuse the group when an in-group steer flips pending→confirmed", () => {
    const u = user("run", 0);
    const a = streamingAssistant("working…", 100);
    const t = tool("Bash", 1_000, 2_000);
    const pendingSteer: Message = {
      kind: "user",
      id: "steer-1",
      text: "also check logs",
      injected: true,
      pending: true,
      createdAt: 2_500,
    };
    const confirmedSteer: Message = { ...pendingSteer, pending: false };

    const prev = reconcileStreamItems(
      [],
      buildStreamItems([u, a, t, pendingSteer], { liveTurnActive: true }),
    );
    const next = buildStreamItems([u, a, t, confirmedSteer], { liveTurnActive: true });
    const reconciled = reconcileStreamItems(prev, next);
    const prevGroup = prev.find((i) => i.kind === "turn_process_group");
    const recGroup = reconciled.find((i) => i.kind === "turn_process_group");
    expect(recGroup).not.toBe(prevGroup);
  });

  test("empty previous render passes new items through unchanged", () => {
    const next = buildStreamItems([user(), tool("Read", 10, 15), tool("Grep", 16, 20)]);
    expect(reconcileStreamItems([], next)).toBe(next);
  });

  test("plain (non-group) messages pass through by their own identity", () => {
    const prev = buildStreamItems([user(), assistant("hi")]);
    const next = buildStreamItems([user(), assistant("hi")]);
    const reconciled = reconcileStreamItems(prev, next);
    // No groups to reuse → returns the new array as-is.
    expect(reconciled).toBe(next);
  });
});
