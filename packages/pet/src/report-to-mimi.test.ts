import { describe, expect, test } from "bun:test";
import type {
  ProtocolObserverHost,
  ToolContext,
  ToolVisibilityContext,
} from "@cjhyy/code-shell-core/extension";
import { createPetCapability } from "./capability.js";
import { PET_REPORT_TO_MIMI_METHOD, type PetReportToMimiEvent } from "./protocol.js";
import {
  REPORT_TO_MIMI_TOOL_NAME,
  reportToMimiAvailability,
  reportToMimiTool,
} from "./report-to-mimi.js";

const WORK_SESSION_ID = "pet-work-806bb2404fc122889366de82";

function visibility(overrides: Partial<ToolVisibilityContext> = {}): ToolVisibilityContext {
  return {
    cwd: "/work/project",
    hasGoal: false,
    sessionId: WORK_SESSION_ID,
    isSubAgent: false,
    ...overrides,
  };
}

describe("ReportToMimi tool", () => {
  test("is visible in every valid Session, including sub-sessions and Pet work", () => {
    expect(reportToMimiAvailability(visibility())).toBe(true);
    expect(reportToMimiAvailability(visibility({ sessionId: "ordinary-session" }))).toBe(true);
    expect(reportToMimiAvailability(visibility({ isSubAgent: true }))).toBe(true);
    expect(reportToMimiAvailability(visibility({ behaviorProfile: "pet" }))).toBe(true);
    expect(reportToMimiAvailability(visibility({ sessionId: undefined }))).toBe(false);
    expect(reportToMimiAvailability(visibility({ sessionId: " bad-session " }))).toBe(false);
  });

  test("emits bounded content without accepting a channel, recipient, or hidden Mimi id", async () => {
    const reports: PetReportToMimiEvent[] = [];
    const result = await reportToMimiTool(
      {
        message: " 图片已经生成。 ",
        attachment_paths: ["/Users/admin/Downloads/pet-comic-v2.png"],
      },
      {
        sessionId: WORK_SESSION_ID,
        originClientMessageId: "message-1",
      } as unknown as ToolContext,
      (event) => reports.push(event),
    );

    expect(result).toContain("Report accepted");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      sessionId: WORK_SESSION_ID,
      message: "图片已经生成。",
      attachmentPaths: ["/Users/admin/Downloads/pet-comic-v2.png"],
    });
    expect(reports[0]?.reportId).toMatch(/^[a-f0-9]{32}$/u);
    expect(reports[0]).not.toHaveProperty("channel");
    expect(reports[0]).not.toHaveProperty("target");
    expect(reports[0]).not.toHaveProperty("petSessionId");
  });

  test("rejects malformed or unauthorized reports before notifying the host", async () => {
    const reports: PetReportToMimiEvent[] = [];
    const sink = (event: PetReportToMimiEvent) => reports.push(event);
    const context = {
      sessionId: WORK_SESSION_ID,
    } as unknown as ToolContext;

    await expect(
      reportToMimiTool({ message: "x", channel: "wechat" }, context, sink),
    ).resolves.toContain("only message and attachment_paths");
    await expect(
      reportToMimiTool({ message: "x", attachment_paths: ["~/image.png"] }, context, sink),
    ).resolves.toContain("absolute paths");
    await expect(
      reportToMimiTool(
        { message: "x", attachment_paths: ["/tmp/a.png", "/tmp/a.png"] },
        context,
        sink,
      ),
    ).resolves.toContain("absolute paths");
    await expect(
      reportToMimiTool({ message: "x" }, { sessionId: "" } as unknown as ToolContext, sink),
    ).resolves.toContain("valid current Session");
    expect(reports).toEqual([]);
  });

  test("routes the catalog tool through the protocol observer notification", async () => {
    const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
    const capability = createPetCapability();
    const observer = capability.createProtocolObserver?.({
      getLiveSessionSnapshot: () => [],
      projectionGeneration: () => 1,
      getSessionKind: () => undefined,
      isTransportDisconnected: () => false,
      notify: (method, params) => notifications.push({ method, params }),
      registerQuery: () => undefined,
    } satisfies ProtocolObserverHost);
    const tool = capability.catalogTools?.find(
      (candidate) => candidate.definition.name === REPORT_TO_MIMI_TOOL_NAME,
    );

    expect(tool).toBeDefined();
    expect(tool?.exposure.availability?.(visibility())).toBe(true);
    await tool?.execute({ message: "done" }, {
      sessionId: WORK_SESSION_ID,
    } as unknown as ToolContext);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      method: PET_REPORT_TO_MIMI_METHOD,
      params: { sessionId: WORK_SESSION_ID, message: "done" },
    });

    observer?.onServerClose?.();
    await expect(
      tool?.execute({ message: "again" }, { sessionId: WORK_SESSION_ID } as unknown as ToolContext),
    ).resolves.toContain("unavailable");
  });
});
