import { describe, expect, it } from "bun:test";
import { placeLiveAutomationSession } from "./liveSession";
import type { ProjectLike } from "./pathMatch";

const projects: ProjectLike[] = [
  { id: "r1", name: "proj", path: "/Users/me/proj" },
  { id: "r2", name: "other", path: "/Users/me/other" },
];

describe("placeLiveAutomationSession", () => {
  it("attributes the session to the repo whose path matches the cwd", () => {
    const { projectId, summary } = placeLiveAutomationSession(
      {
        sessionId: "sess-1",
        cwd: "/Users/me/proj",
        title: "⚙ nightly 2026/6/2",
        cronJobId: "job-7",
      },
      projects,
      { caseInsensitive: true, createProjectForCwd: () => "SHOULD_NOT_CREATE" },
    );
    expect(projectId).toBe("r1");
    expect(summary.id).toBe("sess-1");
    expect(summary.engineSessionId).toBe("sess-1");
    expect(summary.source).toBe("automation");
    expect(summary.runStatus).toBe("running");
    expect(summary.cronJobId).toBe("job-7");
    expect(summary.title).toBe("⚙ nightly 2026/6/2");
  });

  it("matches case-insensitively and tolerates a trailing slash", () => {
    const { projectId } = placeLiveAutomationSession(
      { sessionId: "s", cwd: "/USERS/ME/PROJ/", title: "t", cronJobId: "j" },
      projects,
      { caseInsensitive: true, createProjectForCwd: () => "x" },
    );
    expect(projectId).toBe("r1");
  });

  it("auto-creates a repo for an unmatched (real) cwd", () => {
    let createdWith = "";
    const { projectId } = placeLiveAutomationSession(
      { sessionId: "s", cwd: "/Users/me/fresh", title: "t", cronJobId: "j" },
      projects,
      {
        caseInsensitive: true,
        createProjectForCwd: (cwd) => {
          createdWith = cwd;
          return "new-repo";
        },
      },
    );
    expect(projectId).toBe("new-repo");
    expect(createdWith).toBe("/Users/me/fresh");
  });

  it("places a live session into the root repo after resolving a git subdirectory cwd", () => {
    let created = false;
    const { projectId } = placeLiveAutomationSession(
      { sessionId: "s", cwd: "/Users/me/proj/packages/desktop", title: "t", cronJobId: "j" },
      projects,
      {
        caseInsensitive: true,
        resolveCwd: (cwd) => (cwd === "/Users/me/proj/packages/desktop" ? "/Users/me/proj" : cwd),
        createProjectForCwd: () => {
          created = true;
          return "SHOULD_NOT_CREATE";
        },
      },
    );
    expect(created).toBe(false);
    expect(projectId).toBe("r1");
  });

  it("returns null for an unmatched cwd when repo creation returns null", () => {
    const placement = placeLiveAutomationSession(
      { sessionId: "s", cwd: "/Users/me/removed", title: "t", cronJobId: "j" },
      projects,
      { caseInsensitive: true, createProjectForCwd: () => null },
    );
    expect(placement).toBeNull();
  });

  it("routes an ephemeral/temp cwd to chat (projectId null), never creating a repo", () => {
    let called = false;
    const { projectId } = placeLiveAutomationSession(
      { sessionId: "s", cwd: "/tmp/claude-501/rm-usage-2-x", title: "t", cronJobId: "j" },
      projects,
      {
        caseInsensitive: true,
        createProjectForCwd: () => {
          called = true;
          return "X";
        },
      },
    );
    expect(projectId).toBeNull();
    expect(called).toBe(false);
  });

  it("falls back to a default title and caps length", () => {
    const long = "x".repeat(100);
    const { summary } = placeLiveAutomationSession(
      { sessionId: "s", cwd: "/Users/me/fresh", title: long, cronJobId: "j" },
      projects,
      { caseInsensitive: true, createProjectForCwd: () => "n" },
    );
    expect(summary.title.length).toBe(60);

    const empty = placeLiveAutomationSession(
      { sessionId: "s2", cwd: "/tmp/fresh", title: "", cronJobId: "j" },
      projects,
      { caseInsensitive: true, createProjectForCwd: () => "n" },
    );
    expect(empty.summary.title).toBe("automation");
  });
});
