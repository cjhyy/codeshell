import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  transcriptToFoldItems,
  getSessionTranscript,
  getSessionTranscriptPage,
} from "./transcript-reader";
import { foldTranscript } from "../renderer/automation/foldTranscript";

function line(type: string, data: Record<string, unknown>): string {
  return JSON.stringify({ id: "x", type, timestamp: 1, turnNumber: 0, data });
}

describe("transcriptToFoldItems", () => {
  it("maps a simple user→assistant turn", () => {
    const jsonl = [
      line("session_meta", { sessionId: "sess-1", cwd: "/repo" }),
      line("message", { role: "user", content: "hello" }),
      line("message", { role: "assistant", content: "hi there" }),
      line("turn_boundary", { turnNumber: 1 }),
    ].join("\n");
    const items = transcriptToFoldItems(jsonl);
    // Each FoldItem carries the event's original persisted timestamp (the
    // fixture stamps every line with timestamp:1) so replay can recover the
    // real asked-at / answered-at and elapsed instead of showing 0s.
    expect(items[0]).toEqual({
      kind: "stream",
      event: { type: "session_started", sessionId: "sess-1", promptTokens: 0 },
      timestamp: 1,
    });
    expect(items[1]).toEqual({ kind: "user", text: "hello", timestamp: 1 });
    expect(items[2]).toEqual({
      kind: "stream",
      event: { type: "stream_request_start", turnNumber: 0 },
      timestamp: 1,
    });
    expect(items[3]).toEqual({
      kind: "stream",
      event: { type: "text_delta", text: "hi there" },
      timestamp: 1,
    });
    expect(items[4]).toEqual({
      kind: "stream",
      event: { type: "assistant_message", message: { role: "assistant", content: "hi there" } },
      timestamp: 1,
    });
    expect(items[5]).toEqual({
      kind: "stream",
      event: { type: "turn_complete", reason: "completed" },
      timestamp: 1,
    });
  });

  it("marks outbound host receipts so replay replaces a premature delivery claim", () => {
    const items = transcriptToFoldItems(
      line("message", {
        role: "assistant",
        content: "主动消息操作失败：微信发送失败：prepare failed",
        clientMessageId: "pet-host-action-pet-turn-send",
      }),
    );

    expect(items[1]).toEqual({
      kind: "stream",
      event: {
        type: "text_delta",
        text: "<!--PET:HOST_ACTION_REPLACE:pet-turn-send-->主动消息操作失败：微信发送失败：prepare failed",
      },
      timestamp: 1,
    });
    expect(items[2]).toEqual({
      kind: "stream",
      event: {
        type: "assistant_message",
        message: {
          role: "assistant",
          content:
            "<!--PET:HOST_ACTION_REPLACE:pet-turn-send-->主动消息操作失败：微信发送失败：prepare failed",
        },
      },
      timestamp: 1,
    });
  });

  it("also recognizes the truthful platform-acceptance success receipt", () => {
    const items = transcriptToFoldItems(
      line("message", {
        role: "assistant",
        content: "消息已提交到 微信，平台已接受发送请求。",
        clientMessageId: "pet-host-action-pet-turn-accepted",
      }),
    );

    expect(items[1]).toMatchObject({
      kind: "stream",
      event: {
        type: "text_delta",
        text: "<!--PET:HOST_ACTION_REPLACE:pet-turn-accepted-->消息已提交到 微信，平台已接受发送请求。",
      },
    });
  });

  it("recognizes platform-acceptance receipts that include proactive attachments", () => {
    const items = transcriptToFoldItems(
      line("message", {
        role: "assistant",
        content: "消息和 2 个附件已提交到 微信，平台已接受发送请求。",
        clientMessageId: "pet-host-action-pet-turn-attachments",
      }),
    );

    expect(items[1]).toMatchObject({
      kind: "stream",
      event: {
        type: "text_delta",
        text: "<!--PET:HOST_ACTION_REPLACE:pet-turn-attachments-->消息和 2 个附件已提交到 微信，平台已接受发送请求。",
      },
    });
  });

  it("recognizes the current non-terminal platform-acceptance receipt", () => {
    const content = "消息已提交到 微信，平台接口已接受发送请求；尚未确认收件设备已展示。";
    const items = transcriptToFoldItems(
      line("message", {
        role: "assistant",
        content,
        clientMessageId: "pet-host-action-pet-turn-current-accepted",
      }),
    );

    expect(items[1]).toMatchObject({
      kind: "stream",
      event: {
        type: "text_delta",
        text: `<!--PET:HOST_ACTION_REPLACE:pet-turn-current-accepted-->${content}`,
      },
    });
  });

  it("restores the delivery channel carried by a durable Gateway reply", () => {
    const content = "Mooncake 分析完成。";
    const items = transcriptToFoldItems(
      line("message", {
        role: "assistant",
        content,
        clientMessageId: "pet-host-action-replace-delivery-wechat:im:wechat:message-one",
      }),
    );

    expect(items[1]).toMatchObject({
      kind: "stream",
      event: {
        type: "text_delta",
        text: `<!--PET:HOST_ACTION_REPLACE:im%3Awechat%3Amessage-one:wechat-->${content}`,
      },
    });
  });

  it("carries a persisted steerId onto the user FoldItem (step-in dedup key)", () => {
    // Step-gap steering messages are persisted as a real user turn (unmarked),
    // now stamped with the queued-draft id so hydrate can dedup the optimistic
    // bubble against the disk snapshot (session s-mr8s3w5i loss bug).
    const jsonl = [
      line("message", {
        role: "user",
        content: "直接搜一下 给我第8个",
        steerId: "q-1",
        clientMessageId: "client-1",
      }),
    ].join("\n");
    const items = transcriptToFoldItems(jsonl);
    expect(items[0]).toEqual({
      kind: "user",
      text: "直接搜一下 给我第8个",
      steerId: "q-1",
      clientMessageId: "client-1",
      timestamp: 1,
    });
  });

  it("replays a panel displayText instead of its model-facing context envelope", () => {
    const items = transcriptToFoldItems(
      line("message", {
        role: "user",
        content: 'INTERNAL PANEL CONTEXT\n{"selection":["hero-title"]}',
        displayText: "【Design Studio】 把标题改得更醒目",
        clientMessageId: "panel:design-studio:1",
      }),
    );

    expect(items[0]).toEqual({
      kind: "user",
      text: "【Design Studio】 把标题改得更醒目",
      clientMessageId: "panel:design-studio:1",
      timestamp: 1,
    });
  });

  it("skips a synthetic injected user message (background-wakeup system-reminder)", () => {
    // Background-job completion notifications are submitted as a `role:user`
    // turn (the model must see them as a user message), but they are NOT the
    // real user's input — live, the renderer never shows them as a user
    // bubble, only the assistant's reply. The engine persists them with
    // `injected:true`; the reader must drop them on replay so a disk rebuild
    // matches live (no phantom user bubble like "10分钟到了，打开小红书").
    const jsonl = [
      line("message", { role: "user", content: "真正的用户问题" }),
      line("message", {
        role: "user",
        content: "<system-reminder>\n后台任务完成\n</system-reminder>",
        injected: true,
      }),
      line("message", { role: "assistant", content: "好的" }),
    ].join("\n");
    const items = transcriptToFoldItems(jsonl);
    const userItems = items.filter((i) => i.kind === "user");
    // Only the REAL user message survives as a bubble; the injected one is gone.
    expect(userItems).toEqual([{ kind: "user", text: "真正的用户问题", timestamp: 1 }]);
  });

  it("replays persisted external changed files into the renderer stream", () => {
    const items = transcriptToFoldItems(
      line("external_file_changes", {
        jobId: "cc-files",
        cli: "claude",
        cwd: "/repo",
        description: "DriveAgent(claude): edit feature",
        status: "completed",
        changedFiles: ["src/a.ts", "src/b.ts"],
        originClientMessageId: "client-turn-1",
      }),
    );

    expect(items).toEqual([
      {
        kind: "stream",
        event: {
          type: "background_agent_completed",
          agentId: "cc-files",
          description: "DriveAgent(claude): edit feature",
          status: "completed",
          workKind: "cc",
          changedFiles: ["src/a.ts", "src/b.ts"],
          cwd: "/repo",
          originClientMessageId: "client-turn-1",
          enqueuedAt: 1,
        },
        timestamp: 1,
      },
    ]);
  });

  it("maps tool_use + tool_result", () => {
    const jsonl = [
      line("tool_use", { toolName: "Bash", toolCallId: "tc1", args: { command: "ls" } }),
      line("tool_result", { toolCallId: "tc1", toolName: "Bash", result: "a\nb" }),
    ].join("\n");
    const items = transcriptToFoldItems(jsonl);
    expect(items[0]).toEqual({
      kind: "stream",
      event: {
        type: "tool_use_start",
        toolCall: { id: "tc1", toolName: "Bash", args: { command: "ls" } },
      },
      timestamp: 1,
    });
    expect(items[1]).toEqual({
      kind: "stream",
      event: {
        type: "tool_result",
        result: { id: "tc1", toolName: "Bash", result: "a\nb", error: undefined },
      },
      timestamp: 1,
    });
  });

  it("extracts text from assistant content blocks", () => {
    const jsonl = line("message", {
      role: "assistant",
      content: [
        { type: "text", text: "block one" },
        { type: "tool_use", id: "t", name: "X", input: {} },
      ],
    });
    const items = transcriptToFoldItems(jsonl);
    const delta = items.find((i) => i.kind === "stream" && i.event.type === "text_delta");
    expect(delta).toEqual({
      kind: "stream",
      event: { type: "text_delta", text: "block one" },
      timestamp: 1,
    });
  });

  it("skips malformed lines without throwing", () => {
    const jsonl = [
      "not json",
      "null",
      "[]",
      JSON.stringify({ type: "message", data: null }),
      line("message", { role: "user", content: "ok" }),
    ].join("\n");
    const items = transcriptToFoldItems(jsonl);
    expect(items).toEqual([{ kind: "user", text: "ok", timestamp: 1 }]);
  });

  it("maps summary and error", () => {
    const jsonl = [line("summary", { summary: "s" }), line("error", { error: "boom" })].join("\n");
    const items = transcriptToFoldItems(jsonl);
    expect(items[0]).toEqual({
      kind: "stream",
      event: { type: "context_compact", strategy: "summary", before: 0, after: 0 },
      timestamp: 1,
    });
    expect(items[1]).toEqual({
      kind: "stream",
      event: { type: "error", error: "boom" },
      timestamp: 1,
    });
  });

  it("restores a notes boundary without displaying the note or checkpoint replay snapshot", () => {
    const jsonl = [
      line("session_meta", { sessionId: "notes-session", cwd: "/repo" }),
      line("message", { role: "user", content: "继续原会话" }),
      line("message", { role: "assistant", content: "已记下当前进度" }),
      line("turn_boundary", { turnNumber: 1 }),
      line("context_note", {
        text: "internal working note",
        coveredThroughEventId: "old-context",
      }),
      line("context_checkpoint", {
        version: 1,
        noteId: "note-1",
        coveredThroughEventId: "old-context",
        checksum: "checkpoint-checksum",
        messages: [{ role: "user", content: "internal replay snapshot" }],
        clientMessageIds: [],
      }),
    ].join("\n");

    const items = transcriptToFoldItems(jsonl);
    const state = foldTranscript(items);
    expect(state.sessionId).toBe("notes-session");
    expect(state.messages.filter((message) => message.kind === "context_boundary")).toEqual([
      expect.objectContaining({ kind: "context_boundary", strategy: "notes", before: 0, after: 0 }),
    ]);
    expect(state.messages.filter((message) => message.kind === "user")).toEqual([
      expect.objectContaining({ text: "继续原会话" }),
    ]);
    expect(JSON.stringify(state)).toContain("已记下当前进度");
    expect(JSON.stringify(items)).not.toContain("internal working note");
    expect(JSON.stringify(items)).not.toContain("internal replay snapshot");
  });

  it("ignores incomplete or unsupported checkpoint records", () => {
    expect(
      transcriptToFoldItems(
        [
          line("context_checkpoint", { version: 1 }),
          line("context_checkpoint", {
            version: 2,
            noteId: "note-1",
            coveredThroughEventId: "old-context",
            checksum: "checkpoint-checksum",
            messages: [],
            clientMessageIds: [],
          }),
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("replays a context_transfer event with its package provenance", () => {
    const items = transcriptToFoldItems(
      line("context_transfer", {
        summary: "portable background",
        sourceRange: { sessionId: "source", fromEventId: "a", toEventId: "z" },
        sourceEventCount: 12,
        estimatedTokens: 1500,
      }),
    );

    expect(items[0]).toEqual({
      kind: "stream",
      event: {
        type: "context_transfer",
        summary: "portable background",
        sourceSessionId: "source",
        fromEventId: "a",
        toEventId: "z",
        sourceEventCount: 12,
        estimatedTokens: 1500,
      },
      timestamp: 1,
    });
  });

  it("replays persisted goal_progress markers (so history shows the rounds)", () => {
    const jsonl = [
      line("goal_progress", { status: "not_met", round: 1, gaps: "缺测试" }),
      line("goal_progress", { status: "met", round: 2 }),
    ].join("\n");
    const items = transcriptToFoldItems(jsonl);
    expect(items[0]).toEqual({
      kind: "stream",
      event: { type: "goal_progress", status: "not_met", round: 1, gaps: "缺测试" },
      timestamp: 1,
    });
    // No gaps field when absent (met / no-gap rounds).
    expect(items[1]).toEqual({
      kind: "stream",
      event: { type: "goal_progress", status: "met", round: 2 },
      timestamp: 1,
    });
  });

  it("reconstructs the task panel from a TodoWrite tool_use (so todos survive a disk reload)", () => {
    // A persistent todo list lives only as the args.todos snapshot on the
    // TodoWrite tool_use event — it is NOT re-emitted on a plain session
    // reopen (engine only replays it inside run()). So when the renderer
    // rebuilds from the disk transcript, the TodoWrite tool_use must ALSO
    // yield a synthetic task_update or the task panel comes back empty.
    const jsonl = line("tool_use", {
      toolName: "TodoWrite",
      toolCallId: "tc1",
      args: {
        todos: [
          { content: "写代码", status: "completed", activeForm: "写代码中" },
          { content: "跑测试", status: "in_progress", activeForm: "跑测试中" },
        ],
      },
    });
    const items = transcriptToFoldItems(jsonl);
    // The tool card itself still replays (matches live behavior — TodoWrite
    // emits both a tool_use_start and a task_update).
    expect(items[0]).toEqual({
      kind: "stream",
      event: {
        type: "tool_use_start",
        toolCall: {
          id: "tc1",
          toolName: "TodoWrite",
          args: {
            todos: [
              { content: "写代码", status: "completed", activeForm: "写代码中" },
              { content: "跑测试", status: "in_progress", activeForm: "跑测试中" },
            ],
          },
        },
      },
      timestamp: 1,
    });
    // …followed by the reconstructed task panel (position-based ids, content→subject).
    expect(items[1]).toEqual({
      kind: "stream",
      event: {
        type: "task_update",
        tasks: [
          { id: "1", subject: "写代码", activeForm: "写代码中", status: "completed" },
          { id: "2", subject: "跑测试", activeForm: "跑测试中", status: "in_progress" },
        ],
      },
      timestamp: 1,
    });
  });

  it("a TodoWrite where everything is completed clears the panel (all-done → empty)", () => {
    const jsonl = line("tool_use", {
      toolName: "TodoWrite",
      toolCallId: "tc2",
      args: { todos: [{ content: "done", status: "completed", activeForm: "doing" }] },
    });
    const items = transcriptToFoldItems(jsonl);
    expect(items[1]).toEqual({
      kind: "stream",
      event: { type: "task_update", tasks: [] },
      timestamp: 1,
    });
  });

  // Robustness: a corrupt/hand-edited transcript line with a non-numeric `round`
  // must not produce `round: NaN` (Number("abc") === NaN) and propagate invalid
  // state into the rendered FoldItem. Fall back to 0.
  it("coerces a corrupt non-numeric goal_progress round to 0, not NaN", () => {
    const jsonl = [
      line("goal_progress", { status: "not_met", round: "oops" }),
      line("goal_progress", { status: "not_met" }), // missing round
    ].join("\n");
    const items = transcriptToFoldItems(jsonl);
    const r0 = (items[0] as { event: { round: number } }).event.round;
    const r1 = (items[1] as { event: { round: number } }).event.round;
    expect(Number.isFinite(r0)).toBe(true);
    expect(r0).toBe(0);
    expect(r1).toBe(0);
  });

  it("uses the event's turn number for assistant stream_request_start", () => {
    const t1 = JSON.stringify({
      id: "x",
      type: "message",
      timestamp: 1,
      turnNumber: 1,
      data: { role: "assistant", content: "second" },
    });
    const items = transcriptToFoldItems(t1);
    const reqStart = items.find(
      (i) => i.kind === "stream" && i.event.type === "stream_request_start",
    );
    expect(reqStart).toEqual({
      kind: "stream",
      event: { type: "stream_request_start", turnNumber: 1 },
      timestamp: 1,
    });
  });
});

describe("getSessionTranscript", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-tr-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns [] for a missing session", async () => {
    expect(await getSessionTranscript("nope", dir)).toEqual([]);
    expect(await getSessionTranscript("a".repeat(129), dir)).toEqual([]);
  });

  it("does not follow a symlinked session directory", async () => {
    if (process.platform === "win32") return;
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cs-tr-outside-"));
    try {
      fs.writeFileSync(
        path.join(outside, "transcript.jsonl"),
        line("message", { role: "user", content: "secret" }),
      );
      fs.symlinkSync(outside, path.join(dir, "linked"));
      expect(await getSessionTranscript("linked", dir)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("reads a session dir transcript.jsonl", async () => {
    const sdir = path.join(dir, "sess-9");
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(
      path.join(sdir, "transcript.jsonl"),
      line("message", { role: "user", content: "yo" }) + "\n",
    );
    expect(await getSessionTranscript("sess-9", dir)).toEqual([
      { kind: "user", text: "yo", timestamp: 1 },
    ]);
  });

  it("hydrates a bounded recent window and expands it for older history", async () => {
    const sdir = path.join(dir, "paged");
    fs.mkdirSync(sdir, { recursive: true });
    const lines = Array.from({ length: 8 }, (_, index) =>
      line("message", {
        role: "user",
        content: `history-${index}-${"x".repeat(120)}`,
        clientMessageId: `m-${index}`,
      }),
    );
    fs.writeFileSync(path.join(sdir, "transcript.jsonl"), `${lines.join("\n")}\n`);

    const recent = await getSessionTranscriptPage("paged", { maxBytes: 400 }, dir);
    const recentTexts = recent.items.flatMap((item) => (item.kind === "user" ? [item.text] : []));
    expect(recent.hasMore).toBe(true);
    expect(recent.loadedBytes).toBe(400);
    expect(recentTexts.some((text) => text.startsWith("history-7-"))).toBe(true);
    expect(recentTexts.some((text) => text.startsWith("history-0-"))).toBe(false);

    const expanded = await getSessionTranscriptPage("paged", { maxBytes: 8_000 }, dir);
    const expandedTexts = expanded.items.flatMap((item) =>
      item.kind === "user" ? [item.text] : [],
    );
    expect(expanded.hasMore).toBe(false);
    expect(expandedTexts.some((text) => text.startsWith("history-0-"))).toBe(true);
    expect(expandedTexts.some((text) => text.startsWith("history-7-"))).toBe(true);
  });

  // ── replay-subagent-cards: rebuild sub-agent cards from "subagent" anchors ──
  function writeSub(id: string, status: string, assistantText: string) {
    const sd = path.join(dir, id);
    fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(path.join(sd, "state.json"), JSON.stringify({ sessionId: id, status }));
    fs.writeFileSync(
      path.join(sd, "transcript.jsonl"),
      line("message", { role: "assistant", content: assistantText }) + "\n",
    );
  }

  function evTypes(items: { kind: string; event?: { type: string } }[]): string[] {
    return items.filter((i) => i.kind === "stream").map((i) => i.event!.type);
  }

  it("rebuilds a COMPLETED sub-agent into a done card with its output", async () => {
    const parent = path.join(dir, "p1");
    fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(
      path.join(parent, "transcript.jsonl"),
      line("subagent", { agentId: "childA", description: "分析 ep01" }) + "\n",
    );
    writeSub("childA", "completed", "导演分析完成,已写入 01-director-analysis.md");

    const items = await getSessionTranscript("p1", dir);
    expect(evTypes(items)).toEqual(["agent_start", "text_delta", "agent_end"]);
    const end = items.find(
      (i) => i.kind === "stream" && (i as { event: { type: string } }).event.type === "agent_end",
    ) as { event: { error?: string; text?: string } } | undefined;
    expect(end!.event.error).toBeUndefined(); // completed → no error
    expect(end!.event.text).toContain("01-director-analysis.md");
  });

  it("replays child tools, outputs and prose inside their own card with original timing", async () => {
    const parent = path.join(dir, "parent-details");
    fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(
      path.join(parent, "transcript.jsonl"),
      [
        line("session_meta", { sessionId: "parent-details" }),
        line("message", { role: "user", content: "parent request" }),
        line("subagent", { agentId: "child-details", description: "inspect the project" }),
        line("message", { role: "assistant", content: "parent answer" }),
      ].join("\n"),
    );
    writeSub("child-details", "completed", "");
    const image = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" },
    };
    const timedLine = (type: string, data: Record<string, unknown>, timestamp: number) =>
      JSON.stringify({ id: `event-${timestamp}`, type, timestamp, turnNumber: 1, data });
    fs.writeFileSync(
      path.join(dir, "child-details", "transcript.jsonl"),
      [
        timedLine("session_meta", { sessionId: "child-details" }, 5),
        timedLine("message", { role: "user", content: "private child instruction" }, 10),
        timedLine("message", { role: "assistant", content: "Reading the configuration." }, 20),
        timedLine(
          "tool_use",
          { toolCallId: "read", toolName: "Read", args: { file_path: "/repo/config.json" } },
          30,
        ),
        timedLine(
          "tool_result",
          {
            toolCallId: "read",
            toolName: "Read",
            result: "configuration contents",
            contentBlocks: [image],
          },
          80,
        ),
        timedLine(
          "tool_use",
          { toolCallId: "check", toolName: "Bash", args: { command: "bun test" } },
          100,
        ),
        timedLine(
          "tool_result",
          {
            toolCallId: "check",
            toolName: "Bash",
            result: "test output",
            error: "one check failed",
          },
          140,
        ),
        // Neither a child task list nor its run boundaries can affect the parent.
        timedLine(
          "tool_use",
          {
            toolCallId: "todo",
            toolName: "TodoWrite",
            args: { todos: [{ content: "child work", status: "in_progress" }] },
          },
          150,
        ),
        timedLine("turn_boundary", {}, 160),
        timedLine(
          "message",
          { role: "assistant", content: [{ type: "text", text: "Inspection complete." }] },
          180,
        ),
      ].join("\n"),
    );

    const full = await getSessionTranscript("parent-details", dir);
    const paged = await getSessionTranscriptPage("parent-details", {}, dir);
    expect(paged.items).toEqual(full);
    const state = foldTranscript(full);
    expect(state.sessionId).toBe("parent-details");
    expect(state.messages.filter((m) => m.kind === "user").map((m) => m.text)).toEqual([
      "parent request",
    ]);
    expect(state.messages.filter((m) => m.kind === "assistant").map((m) => m.text)).toEqual([
      "parent answer",
    ]);
    expect(state.messages.some((m) => m.kind === "tool" || m.kind === "task_list")).toBe(false);
    const agent = state.messages.find((m) => m.kind === "agent");
    expect(agent?.kind).toBe("agent");
    if (agent?.kind !== "agent") throw new Error("missing child card");
    expect(agent.text).toBe("Reading the configuration.\n\nInspection complete.");
    expect(agent.textBuffer).toBe("");
    expect(agent.done).toBe(true);
    expect(agent.error).toBeUndefined();
    expect(agent.endedAt).toBe(180);
    expect(agent.toolCalls.map((tool) => tool.id)).toEqual(["read", "check", "todo"]);
    expect(agent.toolCalls[0]).toMatchObject({
      args: JSON.stringify({ file_path: "/repo/config.json" }),
      result: "configuration contents",
      status: "succeeded",
      startedAt: 30,
      endedAt: 80,
      durationMs: 50,
      images: [{ mediaType: "image/png", data: "aW1hZ2U=" }],
    });
    expect(agent.toolCalls[1]).toMatchObject({
      result: "test output",
      error: "one check failed",
      status: "failed",
      durationMs: 40,
    });
    expect(agent.toolCalls[2]?.status).not.toBe("running");
  });

  it("keeps failed child errors on the child card and preserves the parent answer", async () => {
    const parent = path.join(dir, "parent-failed-child");
    fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(
      path.join(parent, "transcript.jsonl"),
      [
        line("subagent", { agentId: "child-failed", description: "inspect" }),
        line("message", { role: "assistant", content: "parent can continue" }),
      ].join("\n"),
    );
    writeSub("child-failed", "model_error", "partial progress");
    fs.appendFileSync(
      path.join(dir, "child-failed", "transcript.jsonl"),
      line("error", { error: "provider unavailable" }) + "\n",
    );

    const state = foldTranscript(await getSessionTranscript("parent-failed-child", dir));
    expect(state.messages.find((m) => m.kind === "agent")).toMatchObject({
      done: true,
      text: "partial progress",
      error: "provider unavailable",
    });
    expect(state.messages.some((m) => m.kind === "system")).toBe(false);
    expect(state.messages.find((m) => m.kind === "assistant")).toMatchObject({
      text: "parent can continue",
    });
  });

  it("retains child tools when assistant prose is missing or a transcript line is malformed", async () => {
    const parent = path.join(dir, "parent-tools-only");
    fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(
      path.join(parent, "transcript.jsonl"),
      line("subagent", { agentId: "child-tools-only", description: "run a check" }),
    );
    writeSub("child-tools-only", "cancelled", "");
    fs.writeFileSync(
      path.join(dir, "child-tools-only", "transcript.jsonl"),
      [
        "{malformed",
        JSON.stringify({ type: "message", data: [] }),
        line("tool_use", { toolCallId: "call", toolName: "Bash", args: { command: "bun test" } }),
        line("tool_result", {
          toolCallId: "call",
          toolName: "Bash",
          result: "interrupted",
          isError: true,
        }),
      ].join("\n"),
    );

    const state = foldTranscript(await getSessionTranscript("parent-tools-only", dir));
    const agent = state.messages.find((m) => m.kind === "agent");
    expect(agent).toMatchObject({ done: true, error: "子代理已取消", toolCount: 1 });
    if (agent?.kind !== "agent") throw new Error("missing child card");
    expect(agent.toolCalls[0]).toMatchObject({ result: "interrupted", status: "failed" });
  });

  it("rebuilds an INTERRUPTED (stuck active) sub-agent into an interrupted card", async () => {
    const parent = path.join(dir, "p2");
    fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(
      path.join(parent, "transcript.jsonl"),
      line("subagent", { agentId: "childB", description: "复审 ep01" }) + "\n",
    );
    writeSub("childB", "active", "做了一半"); // active = never wrapped up

    const items = await getSessionTranscript("p2", dir);
    const end = items.find(
      (i) => i.kind === "stream" && (i as { event: { type: string } }).event.type === "agent_end",
    ) as { event: { error?: string } } | undefined;
    expect(end).toBeDefined();
    expect(end!.event.error).toContain("中断"); // interrupted → error marker
  });

  it("leaves a bare agent_start (running) when the sub-agent session is gone", async () => {
    const parent = path.join(dir, "p3");
    fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(
      path.join(parent, "transcript.jsonl"),
      line("subagent", { agentId: "ghostX", description: "d" }) + "\n",
    );
    // no sessions/ghostX → can't enrich
    const items = await getSessionTranscript("p3", dir);
    expect(evTypes(items)).toEqual(["agent_start"]); // bare → card shows running
  });
});
