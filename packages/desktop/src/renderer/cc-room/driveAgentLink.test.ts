import { describe, expect, test } from "bun:test";
import type { BackgroundWorkInfo } from "../../preload/types";
import { driveAgentLinkDetail, roomCliKind } from "./driveAgentLink";

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
});
