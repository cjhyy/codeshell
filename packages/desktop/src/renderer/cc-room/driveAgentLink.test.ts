import { describe, expect, test } from "bun:test";
import type { BackgroundWorkInfo } from "../../preload/types";
import {
  driveAgentJobIdFromToolMessage,
  driveAgentLinkDetail,
  driveAgentLinkDetailForToolMessage,
  roomCliKind,
} from "./driveAgentLink";

const sourceSession = { sessionId: "engine-1", shortId: "engine-1", current: true };

describe("DriveAgent CLI links", () => {
  test("maps the two registry CLI names to room kinds", () => {
    expect(roomCliKind("claude")).toBe("claude-code");
    expect(roomCliKind("codex")).toBe("codex");
    expect(roomCliKind("other")).toBeNull();
  });

  test("builds a link only for complete DriveAgent jobs", () => {
    const job: Extract<BackgroundWorkInfo, { kind: "job" }> = {
      kind: "job",
      jobId: "job-1",
      description: "delegate",
      status: "completed",
      startedAt: 1,
      jobKind: "drive-agent",
      externalSessionId: "thread-1",
      cli: "codex",
      cwd: "/repo/worktree",
      sourceSession,
    };
    expect(driveAgentLinkDetail(job)).toEqual({
      externalSessionId: "thread-1",
      cliKind: "codex",
      cwd: "/repo/worktree",
      sourceSessionId: "engine-1",
    });
    expect(driveAgentLinkDetail({ ...job, externalSessionId: undefined })).toBeNull();
    expect(driveAgentLinkDetail({ ...job, jobKind: "video" })).toBeNull();
  });

  test("matches a DriveAgent tool result to its background job", () => {
    const job: Extract<BackgroundWorkInfo, { kind: "job" }> = {
      kind: "job",
      jobId: "cc-abc123",
      description: "DriveAgent(codex): delegate",
      status: "completed",
      startedAt: 1,
      jobKind: "drive-agent",
      externalSessionId: "thread-1",
      cli: "codex",
      cwd: "/repo/worktree",
      sourceSession,
    };
    const message = {
      toolName: "DriveAgent",
      result: "已在后台启动 Codex（jobId cc-abc123）。完成后会通知你结果，无需轮询。",
    };

    expect(driveAgentJobIdFromToolMessage(message)).toBe("cc-abc123");
    expect(driveAgentLinkDetailForToolMessage(message, [job])).toEqual({
      externalSessionId: "thread-1",
      cliKind: "codex",
      cwd: "/repo/worktree",
      sourceSessionId: "engine-1",
    });
    expect(
      driveAgentLinkDetailForToolMessage(message, [{ ...job, externalSessionId: undefined }]),
    ).toBeNull();
  });

  test("does not treat unrelated tools or malformed results as DriveAgent jobs", () => {
    expect(
      driveAgentJobIdFromToolMessage({ toolName: "Bash", result: "jobId cc-abc123" }),
    ).toBeNull();
    expect(
      driveAgentJobIdFromToolMessage({ toolName: "DriveClaudeCode", result: "completed inline" }),
    ).toBeNull();
  });
});
