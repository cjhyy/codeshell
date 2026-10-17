import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueryGuard } from "../../../ui/query-guard.js";
import type { CommandContext } from "../registry.js";
import { gitCommands } from "./git-commands.js";

const reviewCommand = gitCommands.find((command) => command.name === "/review")!;
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Review Command Test",
  GIT_AUTHOR_EMAIL: "review-command@example.test",
  GIT_COMMITTER_NAME: "Review Command Test",
  GIT_COMMITTER_EMAIL: "review-command@example.test",
};
let repository: string;

function git(args: string[]): void {
  execFileSync("git", args, { cwd: repository, env: GIT_ENV, stdio: "pipe" });
}

beforeEach(() => {
  repository = realpathSync(mkdtempSync(join(tmpdir(), "codeshell-review-command-")));
  git(["init", "-q", "--initial-branch=main"]);
  writeFileSync(join(repository, "tracked.txt"), "BASELINE_CONTENT\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "initial"]);
  writeFileSync(join(repository, "staged.txt"), "STAGED_REVIEW_CONTENT\n");
  git(["add", "staged.txt"]);
  writeFileSync(join(repository, "tracked.txt"), "UNSTAGED_REVIEW_CONTENT\n");
  writeFileSync(join(repository, "new.txt"), "UNTRACKED_REVIEW_CONTENT\n");
});

afterEach(() => rmSync(repository, { recursive: true, force: true }));

function context() {
  const prompts: Array<{ prompt: string; sessionId?: string; guarded: boolean }> = [];
  const statuses: string[] = [];
  const sessions: string[] = [];
  const queryGuard = new QueryGuard();
  const guardStates: boolean[] = [];
  queryGuard.subscribe(() => guardStates.push(queryGuard.getSnapshot()));
  const ctx: CommandContext = {
    client: {
      run: async (prompt: string, sessionId?: string) => {
        prompts.push({ prompt, sessionId, guarded: queryGuard.getSnapshot() });
        return { sessionId: "review-session-returned" };
      },
    } as unknown as CommandContext["client"],
    cwd: repository,
    model: "unused-test-model",
    setModel: () => undefined,
    sessionId: "review-session-existing",
    setSessionId: (id) => sessions.push(id),
    queryGuard,
    addStatus: (message) => statuses.push(message),
    addMessage: () => undefined,
    setNextContext: () => undefined,
    exit: () => undefined,
    effort: "medium",
    setEffort: () => undefined,
    tasks: [],
    clearChat: () => undefined,
    chatLog: [],
  };
  return { ctx, prompts, statuses, sessions, guardStates };
}

describe("TUI /review command with real Git scopes", () => {
  test("default review sends staged, unstaged, and untracked changes to the model", async () => {
    const { ctx, prompts, statuses, sessions } = context();
    await reviewCommand.execute("", ctx);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].prompt).toContain("+STAGED_REVIEW_CONTENT");
    expect(prompts[0].prompt).toContain("+UNSTAGED_REVIEW_CONTENT");
    expect(prompts[0].prompt).toContain("+UNTRACKED_REVIEW_CONTENT");
    expect(prompts[0].sessionId).toBe("review-session-existing");
    expect(prompts[0].guarded).toBe(true);
    expect(statuses).toEqual([]);
    expect(sessions).toEqual(["review-session-returned"]);
    expect(ctx.queryGuard.getSnapshot()).toBe(false);
  });

  test("--staged sends only the index patch, excluding unstaged and untracked contents", async () => {
    const { ctx, prompts, statuses } = context();
    await reviewCommand.execute("--staged --json --dimensions=security", ctx);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].prompt).toContain("+STAGED_REVIEW_CONTENT");
    expect(prompts[0].prompt).not.toContain("UNSTAGED_REVIEW_CONTENT");
    expect(prompts[0].prompt).not.toContain("UNTRACKED_REVIEW_CONTENT");
    expect(prompts[0].prompt).toContain("ONLY a JSON object");
    expect(statuses).toEqual([]);
    expect(ctx.queryGuard.getSnapshot()).toBe(false);
  });

  test("invalid scope arguments report a clear error without invoking the model", async () => {
    const { ctx, prompts, statuses, guardStates } = context();
    await reviewCommand.execute("--staged --unstaged", ctx);
    expect(prompts).toEqual([]);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toContain("Review arguments:");
    expect(statuses[0]).toContain("Choose only one review scope");
    expect(guardStates).toEqual([]);
    expect(ctx.queryGuard.getSnapshot()).toBe(false);
  });

  test("collection failure never invokes the model and releases QueryGuard for the next review", async () => {
    writeFileSync(join(repository, "binary.bin"), Buffer.from([0, 1, 2]));
    const { ctx, prompts, statuses, guardStates, sessions } = context();
    await reviewCommand.execute("", ctx);
    expect(prompts).toEqual([]);
    expect(sessions).toEqual([]);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toContain("Review failed: Review incomplete: binary file binary.bin");
    expect(guardStates).toContain(true);
    expect(guardStates.at(-1)).toBe(false);
    expect(ctx.queryGuard.getSnapshot()).toBe(false);
    expect(ctx.queryGuard.getSignal()).toBeNull();

    await reviewCommand.execute("--staged", ctx);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].prompt).toContain("+STAGED_REVIEW_CONTENT");
    expect(ctx.queryGuard.getSnapshot()).toBe(false);
  });

  test("cancelling during asynchronous Git collection never starts a model review afterward", async () => {
    const { ctx, prompts, sessions } = context();
    let queued = false;
    const cancelledOwners: Array<"local" | "external" | null> = [];
    const unsubscribe = ctx.queryGuard.subscribe(() => {
      if (queued || !ctx.queryGuard.getSignal()) return;
      queued = true;
      // tryStart has attached the command's controller. The collector's first
      // Git subprocess is still awaiting I/O when this user cancellation runs.
      queueMicrotask(() => cancelledOwners.push(ctx.queryGuard.forceEnd("user-cancel")));
    });
    try {
      await reviewCommand.execute("", ctx);
    } finally {
      unsubscribe();
    }
    expect(cancelledOwners).toEqual(["local"]);
    expect(prompts).toEqual([]);
    expect(sessions).toEqual([]);
    expect(ctx.queryGuard.getSnapshot()).toBe(false);
    expect(ctx.queryGuard.getSignal()).toBeNull();
  });
});
