import { describe, expect, it } from "bun:test";

import {
  applyAgentProgressPhase,
  applyAgentProgressUsage,
  initialAgentProgress,
  reduceAgentProgress,
} from "./agent-progress.js";

describe("agent progress reducer", () => {
  it("reduces model/tool/result/usage/compaction events without copying tool output", () => {
    let progress = initialAgentProgress(1);
    progress = reduceAgentProgress(progress, { type: "stream_request_start", turnNumber: 1 }, 2);
    expect(progress).toMatchObject({ phase: "model", observedAt: 2 });

    progress = reduceAgentProgress(
      progress,
      {
        type: "tool_use_start",
        toolCall: { id: "t1", toolName: "Read\nSECRET", args: {} },
      },
      3,
    );
    expect(progress.phase).toBe("tool");
    expect(progress.summary).toBe("正在运行 Read SECRET");

    progress = reduceAgentProgress(
      progress,
      { type: "tool_result", result: { id: "t1", toolName: "Read", result: "PRIVATE BODY" } },
      4,
    );
    expect(progress.lastTool?.state).toBe("completed");
    expect(progress.summary).not.toContain("PRIVATE BODY");

    progress = applyAgentProgressUsage(
      progress,
      { promptTokens: 12, completionTokens: 8, totalTokens: 20 },
      5,
    );
    expect(progress.tokens).toEqual({ prompt: 12, completion: 8, total: 20 });

    progress = reduceAgentProgress(
      progress,
      { type: "context_compact", strategy: "summary", before: 10, after: 5 },
      6,
    );
    expect(progress).toMatchObject({ phase: "compacting", observedAt: 6 });
    expect(progress.summary.length).toBeLessThanOrEqual(160);
    expect(progress.summary).not.toMatch(/[\r\n\u0000-\u001f]/);
  });

  it("tracks waiting-permission and finalizing from trusted runtime callbacks", () => {
    let progress = initialAgentProgress(1);
    progress = applyAgentProgressPhase(progress, "waiting-permission", 2, "Write");
    expect(progress).toMatchObject({
      phase: "waiting-permission",
      summary: "等待用户批准 Write",
    });
    progress = applyAgentProgressPhase(progress, "finalizing", 3);
    expect(progress).toMatchObject({ phase: "finalizing", summary: "正在收尾" });
  });
});
