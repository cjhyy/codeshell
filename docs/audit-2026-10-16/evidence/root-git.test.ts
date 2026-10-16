import { test, expect, mock } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Install before Core-facing imports. No model/HTTP request belongs to these fixtures.
globalThis.fetch = (() => { throw new Error("audit denies network"); }) as typeof fetch;
const utils = await import("../../../packages/coding/src/git/utils.ts");
const review = await import("../../../packages/coding/src/review/review-prompt.ts");
// Resolve the command's workspace facade to this frozen source tree. All Git functions remain real.
mock.module("@cjhyy/code-shell-capability-coding/git", () => ({ ...utils, ...review }));
const { gitCommands } = await import("../../../packages/tui/src/cli/commands/builtin/git-commands.ts");

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }).trimEnd();
}
async function fixture(run: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "cs-audit-git-"));
  try {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.name", "Audit Fixture");
    git(dir, "config", "user.email", "fixture@example.invalid");
    writeFileSync(join(dir, "alpha.txt"), "alpha before\n");
    writeFileSync(join(dir, "beta.txt"), "beta before\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "fixture: initial");
    await run(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
function commandContext(cwd: string, run: (prompt: string) => Promise<any>) {
  return {
    cwd, sessionId: "audit-session", addStatus() {}, setSessionId() {},
    client: { run }, queryGuard: { reserve: () => 1, tryStart() {}, end() {} },
  } as any;
}

test("A03 first unstaged status entry loses first filename character", () => fixture(async (dir) => {
  writeFileSync(join(dir, "alpha.txt"), "alpha after\n");
  expect(git(dir, "status", "--porcelain")).toBe(" M alpha.txt");
  expect(utils.getGitStatus(dir)).toEqual([{ status: "M", path: "lpha.txt" }]);
  git(dir, "add", "alpha.txt");
  expect(utils.getGitStatus(dir)).toEqual([{ status: "M", path: "alpha.txt" }]);
}));

test("A04 pipe in legitimate commit subject corrupts log fields", () => fixture(async (dir) => {
  git(dir, "commit", "--allow-empty", "-qm", "feat: a | b");
  const log = utils.getGitLog(dir, 1)[0];
  expect(log.message).toBe("feat: a ");
  expect(log.author).toBe(" b");
  expect(log.date).toBe("Audit Fixture");
}));

test("A05 failed model result still causes /commit to stage and commit", () => fixture(async (dir) => {
  writeFileSync(join(dir, "alpha.txt"), "alpha after\n");
  const before = git(dir, "rev-parse", "HEAD");
  await gitCommands.find((c) => c.name === "/commit")!.execute("", commandContext(dir, async () => ({
    text: "prior-round output", reason: "model_error", sessionId: "audit-session",
  })));
  expect(git(dir, "rev-parse", "HEAD")).not.toBe(before);
  expect(git(dir, "log", "-1", "--format=%s")).toBe("prior-round output");
  expect(git(dir, "status", "--porcelain")).toBe("");
}));

test("A06 /commit generates from unstaged diff then commits unseen staged changes too", () => fixture(async (dir) => {
  writeFileSync(join(dir, "alpha.txt"), "STAGED_ONLY_SENTINEL\n");
  git(dir, "add", "alpha.txt");
  writeFileSync(join(dir, "beta.txt"), "UNSTAGED_SENTINEL\n");
  let prompt = "";
  await gitCommands.find((c) => c.name === "/commit")!.execute("", commandContext(dir, async (p) => {
    prompt = p;
    return { text: "fix: beta only", reason: "completed", sessionId: "audit-session" };
  }));
  expect(prompt).toContain("UNSTAGED_SENTINEL");
  expect(prompt).not.toContain("STAGED_ONLY_SENTINEL");
  expect(git(dir, "show", "HEAD:alpha.txt")).toBe("STAGED_ONLY_SENTINEL");
  expect(git(dir, "show", "--format=", "--name-only", "HEAD").split("\n").sort()).toEqual(["alpha.txt", "beta.txt"]);
}));
