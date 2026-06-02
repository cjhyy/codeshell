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
      { sessionId: "sess-1", cwd: "/Users/me/proj", title: "⚙ nightly 2026/6/2" },
      repos,
      { caseInsensitive: true, createRepoForCwd: () => "SHOULD_NOT_CREATE" },
    );
    expect(repoId).toBe("r1");
    expect(summary.id).toBe("sess-1");
    expect(summary.engineSessionId).toBe("sess-1");
    expect(summary.source).toBe("automation");
    expect(summary.runStatus).toBe("running");
    expect(summary.title).toBe("⚙ nightly 2026/6/2");
  });

  it("matches case-insensitively and tolerates a trailing slash", () => {
    const { repoId } = placeLiveAutomationSession(
      { sessionId: "s", cwd: "/USERS/ME/PROJ/", title: "t" },
      repos,
      { caseInsensitive: true, createRepoForCwd: () => "x" },
    );
    expect(repoId).toBe("r1");
  });

  it("auto-creates a repo for an unmatched cwd", () => {
    let createdWith = "";
    const { repoId } = placeLiveAutomationSession(
      { sessionId: "s", cwd: "/tmp/fresh", title: "t" },
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
    expect(createdWith).toBe("/tmp/fresh");
  });

  it("falls back to a default title and caps length", () => {
    const long = "x".repeat(100);
    const { summary } = placeLiveAutomationSession(
      { sessionId: "s", cwd: "/tmp/fresh", title: long },
      repos,
      { caseInsensitive: true, createRepoForCwd: () => "n" },
    );
    expect(summary.title.length).toBe(60);

    const empty = placeLiveAutomationSession(
      { sessionId: "s2", cwd: "/tmp/fresh", title: "" },
      repos,
      { caseInsensitive: true, createRepoForCwd: () => "n" },
    );
    expect(empty.summary.title).toBe("automation");
  });
});
