import { describe, it, expect, beforeEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { backgroundJobRegistry } from "./background-jobs.js";

describe("backgroundJobRegistry", () => {
  beforeEach(() => backgroundJobRegistry.reset());

  it("tracks a running job per session", () => {
    expect(backgroundJobRegistry.hasRunningForSession("s1")).toBe(false);
    backgroundJobRegistry.start("video-1", "s1");
    expect(backgroundJobRegistry.hasRunningForSession("s1")).toBe(true);
    // other session unaffected
    expect(backgroundJobRegistry.hasRunningForSession("s2")).toBe(false);
  });

  it("clears the job on finish", () => {
    backgroundJobRegistry.start("video-1", "s1");
    backgroundJobRegistry.finish("video-1");
    expect(backgroundJobRegistry.hasRunningForSession("s1")).toBe(false);
  });

  it("hasRunningForSession is true while ANY of the session's jobs run", () => {
    backgroundJobRegistry.start("video-1", "s1");
    backgroundJobRegistry.start("video-2", "s1");
    backgroundJobRegistry.finish("video-1");
    expect(backgroundJobRegistry.hasRunningForSession("s1")).toBe(true);
    backgroundJobRegistry.finish("video-2");
    expect(backgroundJobRegistry.hasRunningForSession("s1")).toBe(false);
  });

  it("notifies subscribers on start and finish", () => {
    let n = 0;
    const unsub = backgroundJobRegistry.subscribe(() => n++);
    backgroundJobRegistry.start("video-1", "s1");
    backgroundJobRegistry.finish("video-1");
    unsub();
    backgroundJobRegistry.start("video-2", "s1"); // after unsub — no count
    expect(n).toBe(2);
  });

  it("finish on an unknown job is a no-op (no throw, no notify)", () => {
    let n = 0;
    const unsub = backgroundJobRegistry.subscribe(() => n++);
    backgroundJobRegistry.finish("nope");
    unsub();
    expect(n).toBe(0);
  });

  it("rejects an invalid sessionId (empty string) without tracking", () => {
    backgroundJobRegistry.start("video-1", "");
    expect(backgroundJobRegistry.hasRunningForSession("")).toBe(false);
  });

  // ── Retention (#2/#5): finished jobs stay visible with a result ──────────

  it("retains a finished job with status + finalText (not deleted)", () => {
    backgroundJobRegistry.start("v1", "s1", "Generating video");
    backgroundJobRegistry.finish("v1", { status: "completed", finalText: "https://out.mp4" });
    const jobs = backgroundJobRegistry.listForSession("s1");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("completed");
    expect(jobs[0].finalText).toBe("https://out.mp4");
    expect(jobs[0].finishedAt).toBeGreaterThan(0);
    // ...but it's no longer "running", so the engine wait-loop won't park on it.
    expect(backgroundJobRegistry.hasRunningForSession("s1")).toBe(false);
  });

  it("finish defaults to completed when no outcome is given", () => {
    backgroundJobRegistry.start("v1", "s1");
    backgroundJobRegistry.finish("v1");
    expect(backgroundJobRegistry.listForSession("s1")[0].status).toBe("completed");
  });

  it("records failure status + error text", () => {
    backgroundJobRegistry.start("v1", "s1");
    backgroundJobRegistry.finish("v1", { status: "failed", finalText: "boom" });
    const j = backgroundJobRegistry.listForSession("s1")[0];
    expect(j.status).toBe("failed");
    expect(j.finalText).toBe("boom");
  });

  it("a started job carries status 'running' and a startedAt", () => {
    backgroundJobRegistry.start("v1", "s1");
    const j = backgroundJobRegistry.listForSession("s1")[0];
    expect(j.status).toBe("running");
    expect(j.startedAt).toBeGreaterThan(0);
  });

  it("listRunningForSession returns only running jobs (goal judge feed)", () => {
    backgroundJobRegistry.start("v1", "s1");
    backgroundJobRegistry.start("v2", "s1");
    backgroundJobRegistry.finish("v1", { status: "completed" });
    const running = backgroundJobRegistry.listRunningForSession("s1");
    expect(running.map((j) => j.jobId)).toEqual(["v2"]);
    // full list still has both.
    expect(backgroundJobRegistry.listForSession("s1")).toHaveLength(2);
  });

  it("dropForSession removes all of a session's jobs (session deleted)", () => {
    backgroundJobRegistry.start("v1", "s1");
    backgroundJobRegistry.finish("v1", { status: "completed" });
    backgroundJobRegistry.start("v2", "s2");
    backgroundJobRegistry.dropForSession("s1");
    expect(backgroundJobRegistry.listForSession("s1")).toHaveLength(0);
    expect(backgroundJobRegistry.listForSession("s2")).toHaveLength(1);
  });

  it("dropForSession aborts running jobs but only removes terminal jobs", () => {
    let runningAborts = 0;
    let terminalAborts = 0;
    backgroundJobRegistry.start("running", "s1", "running", {
      abort: () => {
        runningAborts++;
      },
    });
    backgroundJobRegistry.start("terminal", "s1", "terminal", {
      abort: () => {
        terminalAborts++;
      },
    });
    backgroundJobRegistry.finish("terminal", { status: "completed" });

    backgroundJobRegistry.dropForSession("s1");

    expect(runningAborts).toBe(1);
    expect(terminalAborts).toBe(0);
    expect(backgroundJobRegistry.listForSession("s1")).toEqual([]);
  });

  it("caps retained TERMINAL jobs per session, evicting the oldest (running kept)", () => {
    // Start a running job that must survive the cap.
    backgroundJobRegistry.start("run-keep", "s1");
    // Create > cap terminal jobs.
    const N = 55;
    for (let i = 0; i < N; i++) {
      const id = `t${i}`;
      backgroundJobRegistry.start(id, "s1");
      backgroundJobRegistry.finish(id, { status: "completed" });
    }
    const jobs = backgroundJobRegistry.listForSession("s1");
    const terminal = jobs.filter((j) => j.status !== "running");
    expect(terminal.length).toBeLessThanOrEqual(50);
    // The running job is never evicted.
    expect(jobs.some((j) => j.jobId === "run-keep" && j.status === "running")).toBe(true);
    // The oldest terminal jobs (t0, t1, …) are the ones dropped.
    expect(jobs.some((j) => j.jobId === "t0")).toBe(false);
    expect(jobs.some((j) => j.jobId === `t${N - 1}`)).toBe(true);
  });

  it("records DriveAgent metadata and cancels through the stored abort handle", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "drive-job-registry-"));
    try {
      let aborts = 0;
      backgroundJobRegistry.start("cc-1", "s1", "DriveAgent(claude): inspect repo", {
        kind: "drive-agent",
        cli: "claude",
        cwd: tmp,
        promptSummary: "inspect repo and report likely edits",
        abort: () => {
          aborts++;
        },
      });

      const running = backgroundJobRegistry.get("cc-1");
      expect(running).toMatchObject({
        jobId: "cc-1",
        sessionId: "s1",
        kind: "drive-agent",
        cli: "claude",
        launchCwd: realpathSync(tmp),
        cwd: realpathSync(tmp),
        promptSummary: "inspect repo and report likely edits",
        status: "running",
      });

      await expect(
        backgroundJobRegistry.cancel("cc-1", {
          finalText: "Cancelled by DriveAgentJobs.",
        }),
      ).resolves.toBe(true);
      expect(aborts).toBe(1);

      const cancelled = backgroundJobRegistry.get("cc-1");
      expect(cancelled?.status).toBe("cancelled");
      expect(cancelled?.finalText).toBe("Cancelled by DriveAgentJobs.");
      expect(cancelled?.finishedAt).toBeGreaterThan(0);
      expect(backgroundJobRegistry.hasRunningForSession("s1")).toBe(false);

      await expect(backgroundJobRegistry.cancel("cc-1")).resolves.toBe(false);
      expect(aborts).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("detects different launch directories inside the same effective git workspace", () => {
    const repo = mkdtempSync(join(tmpdir(), "drive-job-workspace-same-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: repo });
      const firstCwd = join(repo, "packages", "first");
      const secondCwd = join(repo, "packages", "second");
      mkdirSync(firstCwd, { recursive: true });
      mkdirSync(secondCwd, { recursive: true });

      backgroundJobRegistry.start("first", "s1", "first", { cwd: firstCwd });

      expect(backgroundJobRegistry.listRunningByCwd(secondCwd).map((job) => job.jobId)).toEqual([
        "first",
      ]);
      expect(backgroundJobRegistry.get("first")?.effectiveWorkspaceRoot).toBe(realpathSync(repo));
      expect(backgroundJobRegistry.get("first")?.gitCommonDir).toBe(
        realpathSync(join(repo, ".git")),
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("does not conflate different declared effective workspaces with the same launch cwd", () => {
    const tmp = mkdtempSync(join(tmpdir(), "drive-job-workspace-distinct-"));
    try {
      const launchCwd = join(tmp, "launcher");
      const firstWorkspace = join(tmp, "first-workspace");
      const secondWorkspace = join(tmp, "second-workspace");
      mkdirSync(launchCwd);
      mkdirSync(firstWorkspace);
      mkdirSync(secondWorkspace);
      execFileSync("git", ["init", "--quiet"], { cwd: firstWorkspace });
      execFileSync("git", ["init", "--quiet"], { cwd: secondWorkspace });

      backgroundJobRegistry.start("first", "s1", "first", {
        launchCwd,
        effectiveWorkspaceCwd: firstWorkspace,
      });
      backgroundJobRegistry.start("second", "s2", "second", {
        launchCwd,
        effectiveWorkspaceCwd: secondWorkspace,
      });

      expect(
        backgroundJobRegistry.listRunningByCwd(secondWorkspace).map((job) => job.jobId),
      ).toEqual(["second"]);
      expect(backgroundJobRegistry.get("first")?.launchCwd).toBe(realpathSync(launchCwd));
      expect(backgroundJobRegistry.get("first")?.cwd).toBe(realpathSync(launchCwd));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not conflate linked worktrees that share a main repository", () => {
    const tmp = mkdtempSync(join(tmpdir(), "drive-job-worktree-distinct-"));
    const repo = join(tmp, "main");
    const linked = join(tmp, "linked");
    try {
      mkdirSync(repo);
      execFileSync("git", ["init", "--quiet"], { cwd: repo });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=CodeShell Test",
          "-c",
          "user.email=codeshell@example.invalid",
          "commit",
          "--quiet",
          "--allow-empty",
          "-m",
          "init",
        ],
        { cwd: repo },
      );
      execFileSync("git", ["worktree", "add", "--quiet", "-b", "linked-test", linked], {
        cwd: repo,
      });

      backgroundJobRegistry.start("main", "s1", "main", { cwd: repo });

      expect(backgroundJobRegistry.listRunningByCwd(linked)).toEqual([]);
      const main = backgroundJobRegistry.get("main");
      expect(main?.effectiveWorkspaceRoot).toBe(realpathSync(repo));
      expect(main?.gitCommonDir).toBe(realpathSync(join(repo, ".git")));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("matches the effective cwd snapshot when registration git resolution succeeds then query fails", () => {
    const tmp = mkdtempSync(join(tmpdir(), "drive-job-workspace-git-to-fallback-"));
    try {
      const launchCwd = join(tmp, "launcher");
      const repo = join(tmp, "repo");
      const effectiveCwd = join(repo, "packages", "target");
      mkdirSync(launchCwd);
      mkdirSync(effectiveCwd, { recursive: true });
      execFileSync("git", ["init", "--quiet"], { cwd: repo });

      backgroundJobRegistry.start("git-first", "s1", "git first", {
        launchCwd,
        effectiveWorkspaceCwd: effectiveCwd,
      });
      expect(backgroundJobRegistry.get("git-first")?.effectiveWorkspaceKind).toBe("git-worktree");

      renameSync(join(repo, ".git"), join(repo, ".git-disabled"));

      expect(backgroundJobRegistry.listRunningByCwd(effectiveCwd).map((job) => job.jobId)).toEqual([
        "git-first",
      ]);
      expect(backgroundJobRegistry.get("git-first")?.effectiveWorkspaceCwd).toBe(
        realpathSync(effectiveCwd),
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("matches the effective cwd snapshot when registration git resolution fails then query succeeds", () => {
    const tmp = mkdtempSync(join(tmpdir(), "drive-job-workspace-fallback-to-git-"));
    try {
      const launchCwd = join(tmp, "launcher");
      const repo = join(tmp, "repo");
      const effectiveCwd = join(repo, "packages", "target");
      mkdirSync(launchCwd);
      mkdirSync(effectiveCwd, { recursive: true });

      backgroundJobRegistry.start("fallback-first", "s1", "fallback first", {
        launchCwd,
        effectiveWorkspaceCwd: effectiveCwd,
      });
      expect(backgroundJobRegistry.get("fallback-first")?.effectiveWorkspaceKind).toBe("cwd");

      execFileSync("git", ["init", "--quiet"], { cwd: repo });

      expect(backgroundJobRegistry.listRunningByCwd(effectiveCwd).map((job) => job.jobId)).toEqual([
        "fallback-first",
      ]);
      expect(backgroundJobRegistry.get("fallback-first")?.effectiveWorkspaceCwd).toBe(
        realpathSync(effectiveCwd),
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to the legacy normalized cwd comparison outside git", () => {
    const tmp = mkdtempSync(join(tmpdir(), "drive-job-workspace-fallback-"));
    try {
      const sibling = join(tmp, "sibling");
      mkdirSync(sibling);
      backgroundJobRegistry.start("plain", "s1", "plain", { cwd: `${tmp}/` });

      expect(backgroundJobRegistry.listRunningByCwd(tmp).map((job) => job.jobId)).toEqual([
        "plain",
      ]);
      expect(backgroundJobRegistry.listRunningByCwd(sibling)).toEqual([]);
      expect(backgroundJobRegistry.get("plain")?.effectiveWorkspaceRoot).toBe(realpathSync(tmp));
      expect(backgroundJobRegistry.get("plain")?.gitCommonDir).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("publishes cancelling then cancelled when abort synchronously tries to finish", async () => {
    backgroundJobRegistry.start("cc-reentrant", "s1", "DriveAgent(claude): edit", {
      kind: "drive-agent",
      abort: () => {
        backgroundJobRegistry.finish("cc-reentrant", {
          status: "completed",
          finalText: "late completion",
        });
      },
    });
    const observed: string[] = [];
    const unsubscribe = backgroundJobRegistry.subscribe(() => {
      const status = backgroundJobRegistry.get("cc-reentrant")?.status;
      if (status) observed.push(status);
    });

    await expect(backgroundJobRegistry.cancel("cc-reentrant")).resolves.toBe(true);
    unsubscribe();

    expect(observed).toEqual(["cancelling", "cancelled"]);
    expect(backgroundJobRegistry.get("cc-reentrant")?.status).toBe("cancelled");
  });

  it("keeps a cancelling job active until its async terminator confirms exit", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "drive-job-cancelling-"));
    let releaseTermination!: () => void;
    const termination = new Promise<void>((resolve) => {
      releaseTermination = resolve;
    });
    try {
      backgroundJobRegistry.start("cc-cancelling", "s1", "DriveAgent(codex): edit", {
        kind: "drive-agent",
        cwd: tmp,
        abort: () => termination,
      });

      const cancel = backgroundJobRegistry.cancel("cc-cancelling");
      await Promise.resolve();

      expect(backgroundJobRegistry.get("cc-cancelling")?.status).toBe("cancelling");
      expect(backgroundJobRegistry.hasRunningForSession("s1")).toBe(true);
      expect(backgroundJobRegistry.listRunningByCwd(tmp).map((job) => job.jobId)).toEqual([
        "cc-cancelling",
      ]);

      releaseTermination();
      await expect(cancel).resolves.toBe(true);
      expect(backgroundJobRegistry.get("cc-cancelling")?.status).toBe("cancelled");
      expect(backgroundJobRegistry.hasRunningForSession("s1")).toBe(false);
    } finally {
      releaseTermination?.();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
