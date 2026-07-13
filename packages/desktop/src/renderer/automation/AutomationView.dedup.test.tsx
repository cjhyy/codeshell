import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AutomationDetail } from "./AutomationView";

const job = {
  id: "1",
  name: "夜间复查",
  schedule: "0 22 * * *",
  prompt: "p",
  enabled: true,
  cwd: null,
  timezone: "Asia/Shanghai",
  permissionLevel: "read-only",
  lastRun: 1_700_000_000_000,
  nextRun: 1_800_000_000_000,
  runCount: 12,
  createdAt: 0,
  lastRunId: null,
  once: false,
  resumeSessionId: null,
};
const noop = () => {};
const baseProps = {
  job,
  projects: [],
  toggleBusy: false,
  runNowBusy: false,
  deleteBusy: false,
  saveBusy: false,
  onToggleEnabled: noop,
  onRunNow: noop,
  onDelete: noop,
  onSave: noop,
  onViewRun: noop,
  sessionLinks: [],
  onOpenSession: noop,
} as never;

describe("AutomationDetail dedup", () => {
  test("下次运行/上次运行 appear once (stat cards), not duplicated in FieldRows", () => {
    const html = renderToStaticMarkup(<AutomationDetail {...baseProps} />);
    expect(html.split("下次运行").length - 1).toBe(1);
    expect(html.split("上次运行").length - 1).toBe(1);
  });
  test("状态 FieldRow removed (state lives in header switch)", () => {
    const html = renderToStaticMarkup(<AutomationDetail {...baseProps} />);
    expect(html).not.toContain("状态");
  });
  test("配置 section label present above editable fields", () => {
    const html = renderToStaticMarkup(<AutomationDetail {...baseProps} />);
    expect(html).toContain("配置");
  });
});
