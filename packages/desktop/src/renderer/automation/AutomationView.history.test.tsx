import { describe, expect, test } from "bun:test";
import type { AutomationSummary } from "../../preload/types";
import type { SessionIndex } from "../transcripts";
import { automationSessionLinks } from "./AutomationView";
import { placeLiveAutomationSession } from "./liveSession";
import type { DiskSessionMeta } from "./rebuildFromDisk";

const lastRun = 1_800_000_000_000;
const job = {
  id: "7",
  name: "夜间复查",
  schedule: "1h",
  prompt: "summarize the nightly build failures",
  enabled: true,
  cwd: "/fixture",
  permissionLevel: "read-only",
  lastRun,
  nextRun: lastRun + 3_600_000,
  runCount: 3,
  createdAt: 0,
  lastRunId: null,
  once: false,
  resumeSessionId: null,
} as unknown as AutomationSummary;

const project = {
  id: "p",
  path: "/fixture",
  name: "fixture",
  createdAt: 1,
  primaryRootId: "r",
  roots: [{ id: "r", path: "/fixture", name: "main" }],
};

function disk(over: Partial<DiskSessionMeta> & { id: string }): DiskSessionMeta {
  return {
    engineSessionId: over.id,
    cwd: "/fixture",
    title: "untitled",
    updatedAt: lastRun + 60_000,
    origin: "automation",
    ...over,
  };
}

describe("automation execution history", () => {
  test("a live session announced with this job's cronJobId is listed", () => {
    const placed = placeLiveAutomationSession(
      {
        sessionId: "live-1",
        cwd: "/fixture",
        title: `${job.name} 2026/10/20`,
        cronJobId: job.id,
      },
      [project] as never,
      { caseInsensitive: false, createProjectForCwd: () => null },
    );
    expect(placed).not.toBeNull();
    const indices: Record<string, SessionIndex> = {
      [placed!.projectId ?? "__no_repo__"]: { sessions: [placed!.summary] } as SessionIndex,
    };
    const links = automationSessionLinks(job, indices, [], []);
    expect(links.map((link) => link.session.id)).toEqual([placed!.summary.id]);
  });

  test("a local session of another job is not claimed by a matching title", () => {
    const indices: Record<string, SessionIndex> = {
      p: {
        sessions: [
          {
            id: "other",
            title: job.name,
            createdAt: 1,
            updatedAt: 2,
            source: "automation",
            cronJobId: "8",
          },
        ],
      } as SessionIndex,
    };
    expect(automationSessionLinks(job, indices, [], [])).toEqual([]);
  });

  test("a same-project disk session of another job is not claimed by time proximity", () => {
    const links = automationSessionLinks(
      job,
      {},
      [],
      [
        disk({ id: "job-b", title: "draft the release notes" }),
        disk({
          id: "job-b-tagged",
          title: job.prompt,
          clientMessageId: "automation:8:abc123",
        }),
      ],
    );
    expect(links).toEqual([]);
  });

  test("disk sessions carrying this job's run identity or prompt are listed", () => {
    const links = automationSessionLinks(
      job,
      {},
      [],
      [
        disk({ id: "tagged", title: "LLM title", clientMessageId: `automation:${job.id}:abc123` }),
        disk({ id: "legacy", title: job.prompt, updatedAt: lastRun - 10 * 86_400_000 }),
      ],
    );
    expect(links.map((link) => link.session.id).sort()).toEqual(["legacy", "tagged"]);
  });
});
