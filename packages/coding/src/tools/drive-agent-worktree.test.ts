import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { backgroundJobRegistry } from "@cjhyy/code-shell-core";
import { ExternalAgentSessionStore } from "../cc-orchestrator/external-agent-session-store.js";
import { driveAgentJobsTool, makeDriveAgentTool } from "./drive-agent.js";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
}

function createRepo(prefix: string): { root: string; repo: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "tracked.txt"), "tracked\n");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return { root, repo };
}

async function waitForTerminal(jobId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = backgroundJobRegistry.get(jobId)?.status;
    if (status && status !== "running" && status !== "cancelling") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${jobId}`);
}

afterEach(() => {
  backgroundJobRegistry.reset();
});

describe("DriveAgent worktree isolation lifecycle", () => {
  test("explicit worktree isolation copies includes, preserves changes, and persists the binding", async () => {
    const { root, repo } = createRepo("drive-wt-explicit-");
    try {
      writeFileSync(join(repo, ".gitignore"), ".env\n");
      writeFileSync(join(repo, ".worktreeinclude"), ".env\n");
      git(repo, ["add", ".gitignore", ".worktreeinclude"]);
      git(repo, ["commit", "-q", "-m", "include policy"]);
      writeFileSync(join(repo, ".env"), "TOKEN=test\n");
      const store = new ExternalAgentSessionStore(join(root, "sessions.json"));
      let runnerCwd = "";
      const tool = makeDriveAgentTool(
        async (options) => {
          runnerCwd = options.cwd;
          expect(existsSync(join(options.cwd, ".env"))).toBe(true);
          writeFileSync(join(options.cwd, "agent-result.txt"), "done\n");
          return {
            sessionId: "external-explicit",
            finalText: "finished",
            isError: false,
            exitCode: 0,
            lines: [],
          };
        },
        undefined,
        { sessionStore: store },
      );

      const output = await tool(
        {
          prompt: "edit in isolation",
          cwd: repo,
          isolation: "worktree",
          baseRef: "head",
          cleanup: "auto",
          background: false,
        },
        { cwd: repo, sessionId: "codeshell-explicit" } as any,
      );

      expect(runnerCwd).not.toBe(repo);
      expect(existsSync(runnerCwd)).toBe(true);
      expect(output).toContain("[worktree lifecycle]");
      expect(output).toContain("Worktree kept");
      expect(store.get("claude", "external-explicit")).toMatchObject({
        codeShellSessionId: "codeshell-explicit",
        cwd: runnerCwd,
        workspaceRoot: realpathSync(repo),
        worktreePath: runnerCwd,
        isolation: "worktree",
      });
      expect(git(runnerCwd, ["worktree", "list", "--porcelain"])).not.toContain("locked");
      const branch = git(runnerCwd, ["branch", "--show-current"]);
      git(repo, ["worktree", "remove", runnerCwd, "--force"]);
      git(repo, ["branch", "-D", branch]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(join(root, ".worktrees"), { recursive: true, force: true });
    }
  });

  test("a clean isolated run whose worktree is discarded stays resumable from the workspace root", async () => {
    const { root, repo } = createRepo("drive-wt-clean-resume-");
    try {
      const store = new ExternalAgentSessionStore(join(root, "sessions.json"));
      const seenCwds: string[] = [];
      const tool = makeDriveAgentTool(
        async (options) => {
          seenCwds.push(options.cwd);
          // Clean run: touch nothing, so auto cleanup discards the worktree.
          return {
            sessionId: "external-clean",
            finalText: "nothing to do",
            isError: false,
            exitCode: 0,
            lines: [],
          };
        },
        undefined,
        { sessionStore: store },
      );

      const firstOutput = await tool(
        {
          prompt: "inspect only",
          cwd: repo,
          isolation: "worktree",
          cleanup: "auto",
          background: false,
        },
        { cwd: repo, sessionId: "codeshell-clean" } as any,
      );
      const worktreeCwd = seenCwds[0]!;

      // Clean auto run must discard the worktree directory + branch.
      expect(worktreeCwd).not.toBe(repo);
      expect(existsSync(worktreeCwd)).toBe(false);
      expect(firstOutput).toContain("removed");

      // The binding must NOT point cwd at the deleted worktree path, or resume
      // would be rejected. It should rebind to the (still-present) workspace
      // root as a non-isolated run and drop the dead worktree metadata.
      const binding = store.get("claude", "external-clean");
      expect(binding).toBeDefined();
      expect(binding!.cwd).toBe(realpathSync(repo));
      expect(binding!.isolation).toBe("current");
      expect(binding!.worktreePath).toBeUndefined();

      // Resuming the clean session now succeeds and runs from the workspace root.
      const resumeOutput = await tool(
        {
          prompt: "follow-up",
          resumeSessionId: "external-clean",
          cwd: repo,
          background: false,
        },
        { cwd: repo, sessionId: "codeshell-clean" } as any,
      );
      expect(resumeOutput).not.toContain("cannot resume");
      expect(resumeOutput).not.toContain("no longer exists");
      expect(seenCwds[1]).toBe(realpathSync(repo));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(join(root, ".worktrees"), { recursive: true, force: true });
    }
  });

  test("a parallel writable run is automatically moved to a unique worktree", async () => {
    const { root, repo } = createRepo("drive-wt-parallel-");
    try {
      const tool = makeDriveAgentTool(
        (options) =>
          new Promise((resolve) => {
            options.signal?.addEventListener(
              "abort",
              () =>
                resolve({
                  sessionId: `external-${options.cwd}`,
                  finalText: "cancelled",
                  isError: true,
                  exitCode: null,
                  lines: [],
                }),
              { once: true },
            );
          }),
      );

      await tool({ prompt: "first writer", cwd: repo }, {
        cwd: repo,
        sessionId: "parallel",
      } as any);
      const secondOutput = await tool({ prompt: "second writer", cwd: repo }, {
        cwd: repo,
        sessionId: "parallel",
      } as any);
      const jobs = backgroundJobRegistry.listRunningForSession("parallel");

      expect(jobs).toHaveLength(2);
      expect(jobs[0]).toMatchObject({ isolation: "none", launchCwd: realpathSync(repo) });
      expect(jobs[1]?.isolation).toBe("worktree");
      expect(jobs[1]?.worktreePath).toBeDefined();
      expect(jobs[1]?.worktreePath).not.toBe(repo);
      expect(secondOutput).toContain("Isolation worktree:");
      expect(secondOutput).not.toContain("Concurrent writable agents");

      // Once the direct writer exits, the still-running isolated writer must
      // keep the source checkout busy. A third writer targeting the main repo
      // therefore gets a second distinct worktree instead of silently falling
      // back to the main checkout.
      await driveAgentJobsTool({ action: "cancel", jobId: jobs[0]!.jobId });
      await waitForTerminal(jobs[0]!.jobId);
      const thirdOutput = await tool({ prompt: "third writer", cwd: repo }, {
        cwd: repo,
        sessionId: "parallel",
      } as any);
      const isolated = backgroundJobRegistry
        .listRunningForSession("parallel")
        .filter((job) => job.isolation === "worktree");
      expect(isolated).toHaveLength(2);
      expect(new Set(isolated.map((job) => job.worktreePath)).size).toBe(2);
      expect(thirdOutput).toContain("Isolation worktree:");

      for (const job of isolated) {
        await driveAgentJobsTool({ action: "cancel", jobId: job.jobId });
        await waitForTerminal(job.jobId);
      }
      expect(existsSync(jobs[1]!.worktreePath!)).toBe(false);
      expect(backgroundJobRegistry.get(jobs[1]!.jobId)?.worktreeLifecycle).toBe("discarded");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(join(root, ".worktrees"), { recursive: true, force: true });
    }
  });

  test("DriveAgentJobs cleanup discards a retained terminal worktree", async () => {
    const { root, repo } = createRepo("drive-wt-cleanup-");
    try {
      const tool = makeDriveAgentTool(async (options) => {
        writeFileSync(join(options.cwd, "dirty.txt"), "dirty\n");
        return {
          sessionId: "external-cleanup",
          finalText: "done",
          isError: false,
          exitCode: 0,
          lines: [],
        };
      });
      const started = await tool(
        { prompt: "retain this", cwd: repo, isolation: "worktree", cleanup: "keep" },
        { cwd: repo, sessionId: "cleanup-session" } as any,
      );
      expect(started).toContain("jobId");
      const jobId = backgroundJobRegistry.listForSession("cleanup-session")[0]?.jobId;
      expect(jobId).toBeDefined();
      await waitForTerminal(jobId!);
      const job = backgroundJobRegistry.get(jobId!);
      expect(job?.worktreeLifecycle).toBe("kept");
      expect(existsSync(job!.worktreePath!)).toBe(true);

      const cleanup = await driveAgentJobsTool({
        action: "cleanup",
        jobId,
        cleanup: "discard",
      });

      expect(cleanup).toContain("deleted");
      expect(existsSync(job!.worktreePath!)).toBe(false);
      expect(backgroundJobRegistry.get(jobId!)?.worktreeLifecycle).toBe("discarded");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(join(root, ".worktrees"), { recursive: true, force: true });
    }
  });
});
