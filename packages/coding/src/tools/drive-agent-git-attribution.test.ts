import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backgroundJobRegistry, notificationQueue } from "@cjhyy/code-shell-core/extension";
import { ExternalAgentSessionStore } from "../cc-orchestrator/external-agent-session-store.js";
import { makeDriveAgentTool } from "./drive-agent.js";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
}

const roots: string[] = [];
function createRepo(): { root: string; repo: string } {
  const root = mkdtempSync(join(tmpdir(), "drive-git-attribution-"));
  roots.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "tracked.txt"), "tracked\n");
  writeFileSync(join(repo, ".gitignore"), "*.log\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return { root, repo };
}

async function waitForTerminal(sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const status = backgroundJobRegistry.listForSession(sessionId)[0]?.status;
    if (status && status !== "running" && status !== "cancelling") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for a job of ${sessionId}`);
}

afterEach(() => {
  backgroundJobRegistry.reset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A worker whose only traces are on disk: no patch record, no transcript entry. */
function shellOnlyWorker(root: string, cli: "claude" | "codex" = "claude") {
  const recorded: Array<{ changedFiles: string[]; cwd: string }> = [];
  const tool = makeDriveAgentTool(
    async (options) => {
      writeFileSync(join(options.cwd, "tracked.txt"), "rewritten by sed\n");
      writeFileSync(join(options.cwd, "generated.txt"), "written by a script\n");
      writeFileSync(join(options.cwd, "build.log"), "ignored\n");
      return { sessionId: "ext-1", finalText: "done", isError: false, exitCode: 0, lines: [] };
    },
    undefined,
    {
      sessionStore: new ExternalAgentSessionStore(join(root, "sessions.json")),
      readChangedFiles: () => [],
    },
  );
  const ctx = (sessionId: string) =>
    ({
      sessionId,
      recordExternalFileChanges: (change: { changedFiles: string[]; cwd: string }) =>
        recorded.push(change),
    }) as any;
  return { tool, ctx, recorded, cli };
}

describe("DriveAgent attributes shell-written files in an isolated worktree", () => {
  test("foreground: the work tree's own difference is recorded", async () => {
    const { root, repo } = createRepo();
    const { tool, ctx, recorded } = shellOnlyWorker(root);
    const output = await tool(
      {
        prompt: "regenerate",
        cwd: repo,
        isolation: "worktree",
        cleanup: "discard",
        background: false,
      },
      { ...ctx("S-GIT-FG"), cwd: repo },
    );
    expect(output).toContain("done");
    expect(recorded).toHaveLength(1);
    expect([...recorded[0]!.changedFiles].sort()).toEqual(["generated.txt", "tracked.txt"]);
    expect(recorded[0]!.cwd).not.toBe(repo);
  });

  test("background: the completion carries the same files", async () => {
    const { root, repo } = createRepo();
    const { tool, ctx, recorded } = shellOnlyWorker(root);
    await tool(
      { prompt: "regenerate", cwd: repo, isolation: "worktree", cleanup: "discard" },
      { ...ctx("S-GIT-BG"), cwd: repo },
    );
    await waitForTerminal("S-GIT-BG");
    const job = backgroundJobRegistry.listForSession("S-GIT-BG")[0]!;
    expect([...(job.changedFiles ?? [])].sort()).toEqual(["generated.txt", "tracked.txt"]);
    expect(recorded).toHaveLength(1);
    const [note] = notificationQueue.drainAll("S-GIT-BG") as any[];
    expect([...note.payload.changedFiles].sort()).toEqual(["generated.txt", "tracked.txt"]);
  });

  test("a shared directory is not attributed from git: another writer could be in it", async () => {
    const { root, repo } = createRepo();
    const { tool, ctx, recorded } = shellOnlyWorker(root);
    await tool(
      { prompt: "regenerate", cwd: repo, isolation: "none", background: false },
      { ...ctx("S-GIT-SHARED"), cwd: repo },
    );
    expect(recorded).toEqual([]);
  });
});

describe("DriveAgent names the sandbox of a quiet Codex run", () => {
  const quiet = (root: string, write: boolean) =>
    makeDriveAgentTool(
      async (options) => {
        if (write) writeFileSync(join(options.cwd, "generated.txt"), "x\n");
        return {
          sessionId: "thread-1",
          finalText: "Nothing to change.",
          isError: false,
          exitCode: 0,
          lines: [],
        };
      },
      undefined,
      {
        sessionStore: new ExternalAgentSessionStore(join(root, "sessions.json")),
        readChangedFiles: () => [],
      },
    );
  const ctx = (repo: string, sessionId: string) =>
    ({ cwd: repo, sessionId, permissionMode: "default" }) as any;

  test("no approval and no attributed change: the result says where it ran", async () => {
    const { root, repo } = createRepo();
    const output = await quiet(root, false)(
      { prompt: "tidy", cwd: repo, cli: "codex", background: false },
      ctx(repo, "S-QUIET"),
    );
    expect(output).toContain(
      "[sandbox] Ran in a read-only sandbox; no approval was requested and no file change was recorded.\n\nNothing to change.",
    );
    expect(output).toStartWith("Codex 完成（session thread-1）");

    await quiet(root, false)({ prompt: "tidy", cwd: repo, cli: "codex" }, ctx(repo, "S-QUIET-BG"));
    await waitForTerminal("S-QUIET-BG");
    const [note] = notificationQueue.drainAll("S-QUIET-BG") as any[];
    expect(note.payload.status).toBe("completed");
    expect(note.payload.finalText).toStartWith("[sandbox] Ran in a read-only sandbox;");
  });

  test("a run that changed files, or a Claude Code run, carries no such note", async () => {
    const { root, repo } = createRepo();
    const changed = await quiet(root, true)(
      {
        prompt: "tidy",
        cwd: repo,
        cli: "codex",
        isolation: "worktree",
        cleanup: "discard",
        background: false,
      },
      ctx(repo, "S-CHANGED"),
    );
    expect(changed).not.toContain("[sandbox]");
    const claude = await quiet(root, false)(
      { prompt: "tidy", cwd: repo, cli: "claude", background: false },
      ctx(repo, "S-CLAUDE"),
    );
    expect(claude).not.toContain("[sandbox]");
  });
});
