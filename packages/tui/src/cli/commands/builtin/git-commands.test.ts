import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunResult } from "@cjhyy/code-shell-core";
import type { CommandContext } from "../registry.js";
import { gitCommands } from "./git-commands.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trimEnd();
}

const commit = gitCommands.find((command) => command.name === "/commit")!;

function commandContext(
  cwd: string,
  run: (prompt: string) => Promise<Partial<RunResult>>,
): { ctx: CommandContext; statuses: string[] } {
  const statuses: string[] = [];
  const ctx = {
    cwd,
    sessionId: "session-1",
    addStatus: (text: string) => statuses.push(text),
    setSessionId() {},
    client: { run: async (prompt: string) => ({ sessionId: "session-1", ...(await run(prompt)) }) },
    queryGuard: { reserve: () => 1, tryStart() {}, end() {} },
  } as unknown as CommandContext;
  return { ctx, statuses };
}

describe("/commit", () => {
  let repo: string;

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "cs-commit-")));
    git(repo, "init", "-q");
    git(repo, "config", "user.name", "Fixture Author");
    git(repo, "config", "user.email", "fixture@example.invalid");
    git(repo, "config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "alpha.txt"), "alpha before\n");
    writeFileSync(join(repo, "beta.txt"), "beta before\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "initial");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test("does not stage or commit when message generation does not complete", async () => {
    writeFileSync(join(repo, "alpha.txt"), "alpha after\n");
    const head = git(repo, "rev-parse", "HEAD");
    const { ctx, statuses } = commandContext(repo, async () => ({
      text: "prior-round output",
      reason: "model_error",
    }));

    await commit.execute("", ctx);

    expect(git(repo, "rev-parse", "HEAD")).toBe(head);
    expect(git(repo, "status", "--porcelain")).toBe(" M alpha.txt");
    expect(statuses.join("\n")).toContain("model_error");
  });

  test("shows the model every change the commit will include", async () => {
    writeFileSync(join(repo, "alpha.txt"), "STAGED_SENTINEL\n");
    git(repo, "add", "alpha.txt");
    writeFileSync(join(repo, "beta.txt"), "UNSTAGED_SENTINEL\n");
    writeFileSync(join(repo, "untracked-file.txt"), "new\n");
    let prompt = "";
    const { ctx } = commandContext(repo, async (text) => {
      prompt = text;
      return { text: "chore: update fixtures", reason: "completed" };
    });

    await commit.execute("", ctx);

    expect(prompt).toContain("STAGED_SENTINEL");
    expect(prompt).toContain("UNSTAGED_SENTINEL");
    expect(prompt).toContain("untracked-file.txt");
    expect(git(repo, "log", "-1", "--format=%s")).toBe("chore: update fixtures");
    expect(git(repo, "show", "--format=", "--name-only", "HEAD").split("\n").sort()).toEqual([
      "alpha.txt",
      "beta.txt",
      "untracked-file.txt",
    ]);
  });

  test("from a subdirectory omits unstaged changes that will not be staged", async () => {
    const sub = join(repo, "sub");
    mkdirSync(sub);
    writeFileSync(join(sub, "inside.txt"), "INSIDE_SENTINEL\n");
    writeFileSync(join(repo, "beta.txt"), "OUTSIDE_SENTINEL\n");
    let prompt = "";
    const { ctx } = commandContext(sub, async (text) => {
      prompt = text;
      return { text: "feat: add inside", reason: "completed" };
    });

    await commit.execute("", ctx);

    expect(prompt).toContain("inside.txt");
    expect(prompt).not.toContain("OUTSIDE_SENTINEL");
    expect(git(repo, "show", "--format=", "--name-only", "HEAD")).toBe("sub/inside.txt");
  });
});
