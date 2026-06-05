import { describe, expect, it } from "bun:test";
import { placeLiveAutomationSession } from "./liveSession";
import type { RepoLike } from "./pathMatch";

const repos: RepoLike[] = [
  { id: "r1", name: "proj", path: "/Users/me/proj" },
  { id: "r2", name: "other", path: "/Users/me/other" },
];

describe("placeLiveAutomationSession", () => {
  it("attributes the session to the repo whose path matches the cwd", () => {
    const { repoId, summary } = placeLiveAutomationSession(
      { sessionId: "sess-1", cwd: "/Users/me/proj", title: "⚙ nightly 2026/6/2", cronJobId: "job-7" },
      repos,
      { caseInsensitive: true, createRepoForCwd: () => "SHOULD_NOT_CREATE" },
    );
    expect(repoId).toBe("r1");
    expect(summary.id).toBe("sess-1");
    expect(summary.engineSessionId).toBe("sess-1");
    expect(summary.source).toBe("automation");
    expect(summary.runStatus).toBe("running");
    expect(summary.cronJobId).toBe("job-7");
    expect(summary.title).toBe("⚙ nightly 2026/6/2");
  });

  it("matches case-insensitively and tolerates a trailing slash", () => {
    const { repoId } = placeLiveAutomationSession(
      { sessionId: "s", cwd: "/USERS/ME/PROJ/", title: "t", cronJobId: "j" },
      repos,
      { caseInsensitive: true, createRepoForCwd: () => "x" },
    );
    expect(repoId).toBe("r1");
  });

  it("auto-creates a repo for an unmatched (real) cwd", () => {
    let createdWith = "";
    const { repoId } = placeLiveAutomationSession(
      { sessionId: "s", cwd: "/Users/me/fresh", title: "t", cronJobId: "j" },
      repos,
      {
        caseInsensitive: true,
        createRepoForCwd: (cwd) => {
          createdWith = cwd;
          return "new-repo";
        },
      },
    );
    expect(repoId).toBe("new-repo");
    expect(createdWith).toBe("/Users/me/fresh");
  });

  it("returns null for an unmatched cwd when repo creation returns null", () => {
    const placement = placeLiveAutomationSession(
      { sessionId: "s", cwd: "/Users/me/removed", title: "t", cronJobId: "j" },
      repos,
      { caseInsensitive: true, createRepoForCwd: () => null },
    );
    expect(placement).toBeNull();
  });

  it("routes an ephemeral/temp cwd to chat (repoId null), never creating a repo", () => {
    let called = false;
    const { repoId } = placeLiveAutomationSession(
      { sessionId: "s", cwd: "/tmp/claude-501/rm-usage-2-x", title: "t", cronJobId: "j" },
      repos,
      { caseInsensitive: true, createRepoForCwd: () => { called = true; return "X"; } },
    );
    expect(repoId).toBeNull();
    expect(called).toBe(false);
  });

  it("falls back to a default title and caps length", () => {
    const long = "x".repeat(100);
    const { summary } = placeLiveAutomationSession(
      { sessionId: "s", cwd: "/Users/me/fresh", title: long, cronJobId: "j" },
      repos,
      { caseInsensitive: true, createRepoForCwd: () => "n" },
    );
    expect(summary.title.length).toBe(60);

    const empty = placeLiveAutomationSession(
      { sessionId: "s2", cwd: "/tmp/fresh", title: "", cronJobId: "j" },
      repos,
      { caseInsensitive: true, createRepoForCwd: () => "n" },
    );
    expect(empty.summary.title).toBe("automation");
  });
});
