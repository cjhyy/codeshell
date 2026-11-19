import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  filterSessions,
  loadPinnedSessions,
  PIN_STORAGE_PREFIX,
  savePinnedSessions,
  SessionPinButton,
  SessionSidebarHeader,
  splitPinned,
  togglePinned,
  type SessionSidebar,
} from "./SessionSidebarTools.js";
import { approvalJumpLabel } from "./ApprovalJumpBar.js";
import type { SessionSummary } from "./protocol.js";

const row = (sessionId: string, patch: Partial<SessionSummary> = {}) =>
  ({
    sessionId,
    cwd: "/owned",
    title: "",
    startedAt: 1,
    lastActiveAt: 1,
    status: "completed",
    turnCount: 1,
    ...patch,
  }) as SessionSummary;

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

describe("session search", () => {
  const sessions = [
    row("alpha-1", { title: "部署 checklist" }),
    row("beta-2", { customTitle: "Weekly Report", title: "ignored" }),
    row("gamma-3", { preview: "整理学习计划" }),
  ];

  test("an empty query keeps every row", () => {
    expect(filterSessions(sessions, "  ").map((item) => item.sessionId)).toEqual([
      "alpha-1",
      "beta-2",
      "gamma-3",
    ]);
  });

  test("matches titles, custom titles, previews and IDs case-insensitively", () => {
    expect(filterSessions(sessions, "CHECKLIST").map((item) => item.sessionId)).toEqual([
      "alpha-1",
    ]);
    expect(filterSessions(sessions, "weekly").map((item) => item.sessionId)).toEqual(["beta-2"]);
    expect(filterSessions(sessions, "学习").map((item) => item.sessionId)).toEqual(["gamma-3"]);
    expect(filterSessions(sessions, "gamma").map((item) => item.sessionId)).toEqual(["gamma-3"]);
  });

  test("every term must match", () => {
    expect(filterSessions(sessions, "部署 checklist")).toHaveLength(1);
    expect(filterSessions(sessions, "部署 weekly")).toHaveLength(0);
  });
});

describe("session pins", () => {
  test("toggling puts the newest pin first and unpinning removes it", () => {
    expect(togglePinned([], "a")).toEqual(["a"]);
    expect(togglePinned(["a"], "b")).toEqual(["b", "a"]);
    expect(togglePinned(["b", "a"], "a")).toEqual(["b"]);
  });

  test("pinned rows are lifted out in pin order; unknown pins are ignored", () => {
    const split = splitPinned([row("a"), row("b"), row("c")], ["c", "missing", "a"]);
    expect(split.pinned.map((item) => item.sessionId)).toEqual(["c", "a"]);
    expect(split.rest.map((item) => item.sessionId)).toEqual(["b"]);
  });

  test("pins persist per workspace scope and tolerate corrupt storage", () => {
    const storage = new MemoryStorage();
    savePinnedSessions("hub:/one", ["x", "y"], storage);
    expect(loadPinnedSessions("hub:/one", storage)).toEqual(["x", "y"]);
    expect(loadPinnedSessions("hub:/two", storage)).toEqual([]);
    storage.setItem(PIN_STORAGE_PREFIX + "hub:/bad", "{not json");
    expect(loadPinnedSessions("hub:/bad", storage)).toEqual([]);
    storage.setItem(PIN_STORAGE_PREFIX + "hub:/mixed", JSON.stringify(["x", 3, "", "x"]));
    expect(loadPinnedSessions("hub:/mixed", storage)).toEqual(["x"]);
    savePinnedSessions("hub:/one", [], storage);
    expect(storage.values.has(PIN_STORAGE_PREFIX + "hub:/one")).toBe(false);
  });

  test("the pin control reports its state without repeating the row title", () => {
    const pinned = renderToStaticMarkup(<SessionPinButton pinned onToggle={() => {}} />);
    expect(pinned).toContain('aria-pressed="true"');
    expect(pinned).toContain('aria-label="取消置顶此对话"');
    const unpinned = renderToStaticMarkup(<SessionPinButton pinned={false} onToggle={() => {}} />);
    expect(unpinned).toContain('aria-label="置顶此对话"');
  });
});

describe("sidebar header", () => {
  const sidebar = (patch: Partial<SessionSidebar>): SessionSidebar => ({
    query: "",
    setQuery: () => {},
    isPinned: () => false,
    toggle: () => {},
    pinned: [],
    sessions: [],
    navigationSessions: [],
    ...patch,
  });
  const render = (patch: Partial<SessionSidebar>, total = 2, grouped = false) =>
    renderToStaticMarkup(
      <SessionSidebarHeader
        sidebar={sidebar(patch)}
        total={total}
        grouped={grouped}
        renderSession={(item) => <li key={item.sessionId}>{item.sessionId}</li>}
      />,
    );

  test("stays hidden until there are conversations to search", () => {
    expect(render({}, 0)).toBe("");
    expect(render({ sessions: [row("a")] })).toContain('aria-label="搜索对话"');
  });

  test("shows the 置顶 group and an explicit no-match state", () => {
    expect(render({ pinned: [row("pinned-1")] })).toContain('aria-label="置顶对话"');
    expect(render({ query: "nothing" })).toContain("没有匹配“nothing”的对话");
    // The grouped catalog decides emptiness when it is the visible list.
    expect(render({ query: "x", sessions: [row("a")] }, 2, true)).toContain("没有匹配");
    expect(render({ query: "x", navigationSessions: [row("a")] }, 2, true)).not.toContain(
      "没有匹配",
    );
  });
});

describe("pending approval jump bar", () => {
  test("blocking approvals take precedence over deferrable questions", () => {
    expect(approvalJumpLabel(2, 1)).toBe("1 项操作等待你确认");
    expect(approvalJumpLabel(3, 0)).toBe("3 个问题可稍后回答");
    expect(approvalJumpLabel(150, 120)).toBe("99+ 项操作等待你确认");
  });
});
