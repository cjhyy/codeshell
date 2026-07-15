import { describe, expect, test } from "bun:test";
import type { PetSessionProjection } from "@cjhyy/code-shell-pet";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionStatusSection, sessionDisplayState } from "./SessionStatusSection";

function session(overrides: Partial<PetSessionProjection> = {}): PetSessionProjection {
  return {
    owner: "local-user",
    agentSessionId: "agent-session-12345678",
    coreSessionId: "core-session-secret",
    title: "Build the desktop pet overview",
    workspaceDisplayName: "codeshell",
    runState: "idle",
    queueDepth: 0,
    lastActivityAt: 1_000,
    pendingDecisionCount: 0,
    freshness: { source: "disk", observedAt: 2_000, workerState: "active" },
    ...overrides,
  };
}

describe("SessionStatusSection", () => {
  test("maps every display state and only animates running", () => {
    expect(sessionDisplayState(session({ runState: "running", phase: "waiting-decision" }))).toBe(
      "waiting",
    );
    expect(sessionDisplayState(session({ runState: "running" }))).toBe("running");
    expect(sessionDisplayState(session({ runState: "queued" }))).toBe("queued");
    expect(sessionDisplayState(session({ runState: "idle" }))).toBe("idle");
    expect(sessionDisplayState(session({ runState: "dormant" }))).toBe("dormant");
    expect(sessionDisplayState(session({ runState: "terminal" }))).toBe("terminal");
    expect(sessionDisplayState(session({ runState: "unknown" }))).toBe("unknown");

    const running = renderToStaticMarkup(
      <SessionStatusSection sessions={[session({ runState: "running" })]} now={3_000} />,
    );
    expect(running).toContain("运行中");
    expect(running).toContain('aria-label="状态：运行中"');
    expect(running).toContain("animate-pulse");
    expect(running).toContain("motion-reduce:animate-none");

    const unknown = renderToStaticMarkup(
      <SessionStatusSection sessions={[session({ runState: "unknown" })]} now={3_000} />,
    );
    expect(unknown).toContain("状态未知");
    expect(unknown).not.toContain("animate-pulse");
  });

  test("renders compact safe metadata while omitting core ids and raw payload fields", () => {
    const html = renderToStaticMarkup(
      <SessionStatusSection
        sessions={[
          session({
            summary:
              "A bounded safe summary that is deliberately long enough to be truncated by the row",
          }),
        ]}
        now={62_000}
      />,
    );
    expect(html).toContain("codeshell");
    expect(html).toContain("12345678");
    expect(html).toContain("1 分钟前");
    expect(html).toContain("truncate");
    expect(html).not.toContain("core-session-secret");
    expect(html).not.toContain("raw args");
    expect(html).not.toContain("tool output");
  });

  test("has distinct empty, reclaimed, disconnected, stale, error and reconciling language", () => {
    const states = ["empty", "reclaimed", "disconnected", "stale", "error", "reconciling"] as const;
    const expected = [
      "还没有工作会话",
      "worker 已回收",
      "worker 已断开",
      "状态可能已过期",
      "正在自动重试",
      "正在对账",
    ];
    for (let index = 0; index < states.length; index += 1) {
      const html = renderToStaticMarkup(
        <SessionStatusSection sessions={[]} emptyState={states[index]} />,
      );
      expect(html).toContain(expected[index]);
    }
  });
});
