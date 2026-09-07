import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AutomationDetail } from "./AutomationView";

const baseJob = {
  id: "1",
  name: "n",
  schedule: "0 22 * * *",
  prompt: "p",
  enabled: true,
  cwd: null,
  timezone: "UTC",
  permissionLevel: "read-only",
  lastRun: null,
  nextRun: 1_800_000_000_000,
  runCount: 0,
  createdAt: 0,
  lastRunId: null,
  once: false,
};
const noop = () => {};
const boundSession = {
  projectId: null,
  session: {
    id: "sess-9",
    title: "我的对话",
    updatedAt: 1_700_000_000_000,
    runStatus: "completed",
    engineSessionId: "sess-9",
  },
  run: undefined,
  disk: undefined,
  needsImport: false,
};
const mk = (resumeSessionId: string | null, sessions: unknown[] = []) =>
  ({
    job: { ...baseJob, resumeSessionId },
    projects: [],
    sessions,
    conversations: sessions.map((link: any) => ({
      sessionId: link.session.engineSessionId,
      title: link.session.title,
      updatedAt: link.session.updatedAt,
      projectId: link.projectId,
      projectLabel: "无项目（对话）",
      archived: false,
      session: link.session,
    })),
    toggleBusy: false,
    runNowBusy: false,
    deleteBusy: false,
    saveBusy: false,
    onToggleEnabled: noop,
    onRunNow: noop,
    onDelete: noop,
    onSave: noop,
    onViewRun: noop,
    onOpenRunSession: noop,
    onOpenDiskSession: noop,
    onOpenSession: noop,
  }) as never;

describe("AutomationDetail bound-session branch", () => {
  test("bound ordinary conversation is displayed with inherited settings and an open action", () => {
    const html = renderToStaticMarkup(<AutomationDetail {...mk("sess-9", [boundSession])} />);
    expect(html).toContain("续接对话");
    expect(html).toContain("绑定的对话");
    expect(html).not.toContain("运行 session");
    expect(html).toContain("我的对话");
    expect(html).toContain("打开对话");
    expect(html).toContain("沿用绑定对话的权限和工具设置");
    expect(html).toContain("跟随绑定的对话");
    expect(html).not.toContain("暂时找不到绑定的对话");
  });
  test("resumeSessionId null → history list present, no 续接对话 badge", () => {
    const html = renderToStaticMarkup(<AutomationDetail {...mk(null, [boundSession])} />);
    expect(html).not.toContain("续接对话");
    expect(html).toContain("运行 session");
  });
  test("missing bindings offer recovery without claiming the conversation has never run", () => {
    const html = renderToStaticMarkup(<AutomationDetail {...mk("deleted-session")} />);
    expect(html).toContain("暂时找不到绑定的对话");
    expect(html).toContain("每次新建对话");
    expect(html).not.toContain("尚未运行过");
  });
});
