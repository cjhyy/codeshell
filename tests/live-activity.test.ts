import { describe, expect, it } from "bun:test";
import {
  summarizeLiveActivity,
  formatElapsed,
} from "../packages/desktop/src/renderer/topbar/liveActivity";
import type { Message, ToolMessage } from "../packages/desktop/src/renderer/types";

function user(id: string): Message {
  return { kind: "user", id, text: "hi" };
}
function tool(over: Partial<ToolMessage> & { id: string }): ToolMessage {
  return {
    kind: "tool",
    id: over.id,
    toolName: over.toolName ?? "Bash",
    args: "{}",
    status: over.status ?? "succeeded",
    startedAt: over.startedAt ?? 1000,
    endedAt: over.endedAt ?? 2000,
    ...over,
  } as ToolMessage;
}

describe("summarizeLiveActivity", () => {
  it("counts only tools after the most recent user message", () => {
    const msgs: Message[] = [
      tool({ id: "old1" }), // pre-user — ignored
      user("u1"),
      tool({ id: "t1", toolName: "Bash", startedAt: 1000 }),
      tool({ id: "t2", toolName: "Edit", startedAt: 2000 }),
    ];
    const a = summarizeLiveActivity(msgs);
    expect(a.toolCount).toBe(2);
    expect(a.lastToolName).toBe("Edit");
    expect(a.turnStartedAt).toBe(1000);
    expect(a.toolInFlight).toBe(false);
  });

  it("prefers a running tool's name over the last completed one", () => {
    const msgs: Message[] = [
      user("u1"),
      tool({ id: "t1", toolName: "Bash", status: "succeeded", startedAt: 1000 }),
      tool({ id: "t2", toolName: "WebSearch", status: "running", startedAt: 2000 }),
      tool({ id: "t3", toolName: "Edit", status: "succeeded", startedAt: 1500 }),
    ];
    const a = summarizeLiveActivity(msgs);
    expect(a.lastToolName).toBe("WebSearch");
    expect(a.toolInFlight).toBe(true);
  });

  it("turnStartedAt is the earliest tool start in the current turn", () => {
    const msgs: Message[] = [
      user("u1"),
      tool({ id: "t1", startedAt: 5000 }),
      tool({ id: "t2", startedAt: 3000 }),
      tool({ id: "t3", startedAt: 4000 }),
    ];
    expect(summarizeLiveActivity(msgs).turnStartedAt).toBe(3000);
  });

  it("returns empty defaults when there are no tools yet", () => {
    const msgs: Message[] = [user("u1")];
    const a = summarizeLiveActivity(msgs);
    expect(a.toolCount).toBe(0);
    expect(a.lastToolName).toBe("");
    expect(a.turnStartedAt).toBe(0);
    expect(a.toolInFlight).toBe(false);
  });

  it("walks the whole array when no user message exists", () => {
    const msgs: Message[] = [
      tool({ id: "t1", toolName: "Bash" }),
      tool({ id: "t2", toolName: "Edit" }),
    ];
    expect(summarizeLiveActivity(msgs).toolCount).toBe(2);
  });
});

describe("formatElapsed", () => {
  it("renders sub-second as ms", () => {
    expect(formatElapsed(250)).toBe("250ms");
  });
  it("renders <1m as seconds", () => {
    expect(formatElapsed(12000)).toBe("12s");
  });
  it("renders full minutes without the trailing 0s", () => {
    expect(formatElapsed(120000)).toBe("2m");
  });
  it("renders mixed m+s", () => {
    expect(formatElapsed(75000)).toBe("1m15s");
  });
});
