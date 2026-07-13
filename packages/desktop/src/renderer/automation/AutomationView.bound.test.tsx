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
  test("resumeSessionId set → 续接对话 badge + 绑定的对话 card, no history list header", () => {
    const html = renderToStaticMarkup(<AutomationDetail {...mk("sess-9", [boundSession])} />);
    expect(html).toContain("续接对话");
    expect(html).toContain("绑定的对话");
    expect(html).not.toContain("运行 session");
  });
  test("resumeSessionId null → history list present, no 续接对话 badge", () => {
    const html = renderToStaticMarkup(<AutomationDetail {...mk(null, [boundSession])} />);
    expect(html).not.toContain("续接对话");
    expect(html).toContain("运行 session");
  });
});
