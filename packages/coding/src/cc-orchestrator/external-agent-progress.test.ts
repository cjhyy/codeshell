import { describe, expect, it } from "bun:test";
import { advanceAgentProgress, initialAgentProgress } from "./external-agent-progress.js";

describe("external agent activity", () => {
  it("tracks Claude partial thinking without retaining reasoning or partial tool arguments", () => {
    const initial = initialAgentProgress("claude", 100);
    const thinking = advanceAgentProgress(
      initial,
      "claude",
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "private reasoning" },
        },
      }),
      200,
    );
    expect(thinking).toMatchObject({
      phase: "thinking",
      summary: "Thinking",
      eventCount: 1,
      lastActivityAt: 200,
    });
    expect(JSON.stringify(thinking)).not.toContain("private reasoning");
    const tool = advanceAgentProgress(
      thinking,
      "claude",
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_start",
          content_block: { type: "tool_use", name: "Bash", input: {} },
        },
      }),
      300,
    );
    const delta = advanceAgentProgress(
      tool,
      "claude",
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "input_json_delta", partial_json: '{"command":"TOKEN=secret"}' },
        },
      }),
      400,
    );
    expect(delta).toMatchObject({
      phase: "tool",
      summary: "Running Bash",
      eventCount: 3,
      lastActivityAt: 400,
    });
    expect(JSON.stringify(delta)).not.toContain("secret");
    expect(delta.recentEvents).toHaveLength(2);
    expect(initial.eventCount).toBe(0);
  });

  it("summarizes Claude complete tools and results while excluding result contents", () => {
    let progress = initialAgentProgress("claude", 100);
    progress = advanceAgentProgress(
      progress,
      "claude",
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Read",
              input: { file_path: "src/main.ts", contents: "secret" },
            },
          ],
        },
      }),
      200,
    );
    expect(progress.summary).toBe("Running Read · src/main.ts");
    progress = advanceAgentProgress(
      progress,
      "claude",
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", content: "private result", is_error: true }] },
      }),
      300,
    );
    expect(progress.summary).toBe("Tool reported an error");
    expect(JSON.stringify(progress)).not.toContain("private result");
    expect(JSON.stringify(progress)).not.toContain("secret");
  });

  it("tracks Codex JSONL commands, files and public tool names without raw arguments", () => {
    let progress = initialAgentProgress("codex", 100);
    const events = [
      { type: "thread.started", thread_id: "thread-1" },
      { type: "turn.started" },
      { type: "item.completed", item: { type: "reasoning", text: "private reasoning" } },
      {
        type: "item.started",
        item: { type: "command_execution", command: "TOKEN=secret npm test" },
      },
      {
        type: "item.completed",
        item: { type: "command_execution", exit_code: 1, aggregated_output: "private output" },
      },
      {
        type: "item.completed",
        item: { type: "file_change", changes: [{ path: "src/main.ts", kind: "update" }] },
      },
      {
        type: "item.started",
        item: {
          type: "mcp_tool_call",
          server: "browser",
          tool: "navigate",
          arguments: { url: "private" },
        },
      },
    ];
    for (const [index, event] of events.entries())
      progress = advanceAgentProgress(progress, "codex", JSON.stringify(event), 200 + index);
    expect(progress).toMatchObject({
      phase: "tool",
      summary: "Running browser navigate",
      eventCount: 7,
      lastActivityAt: 206,
    });
    expect(progress.recentEvents?.map((event) => event.summary)).toContain(
      "Command finished (exit 1)",
    );
    expect(progress.recentEvents?.map((event) => event.summary)).toContain(
      "Updated files · src/main.ts",
    );
    expect(JSON.stringify(progress)).not.toContain("private");
    expect(JSON.stringify(progress)).not.toContain("secret");
  });

  it("bounds and sanitizes retained activity and deduplicates repeated text deltas", () => {
    let progress = initialAgentProgress("claude", 100);
    for (let index = 0; index < 12; index++) {
      progress = advanceAgentProgress(
        progress,
        "claude",
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", name: `Tool${index}\u001b[31m\n${"x".repeat(500)}`, input: {} },
            ],
          },
        }),
        200 + index,
      );
    }
    expect(progress.recentEvents).toHaveLength(8);
    expect(progress.recentEvents?.every((event) => event.summary.length <= 240)).toBe(true);
    expect(progress.summary).not.toContain("\u001b");
    expect(progress.summary).not.toContain("\n");
    for (let index = 0; index < 20; index++)
      progress = advanceAgentProgress(
        progress,
        "claude",
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "output" } },
        }),
        300 + index,
      );
    expect(progress.eventCount).toBe(32);
    expect(
      progress.recentEvents?.filter((event) => event.summary === "Writing response"),
    ).toHaveLength(1);
  });

  it("counts unknown or diagnostic output as activity without claiming completed work", () => {
    const initial = initialAgentProgress("codex", 100);
    const progress = advanceAgentProgress(initial, "codex", "a private diagnostic", 200);
    expect(progress).toMatchObject({ phase: "starting", eventCount: 1, lastActivityAt: 200 });
    expect(progress.recentEvents).toEqual([]);
    expect(JSON.stringify(progress)).not.toContain("private");
    expect(advanceAgentProgress(progress, "codex", " ", 300)).toBe(progress);
  });
});
