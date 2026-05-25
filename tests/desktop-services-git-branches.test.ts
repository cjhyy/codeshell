import { afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

mock.module("electron", () => ({
  shell: {
    openExternal: async () => undefined,
    showItemInFolder: () => undefined,
  },
}));

let getGitBranches: typeof import("../packages/desktop/src/main/desktop-services").getGitBranches;
let switchGitBranch: typeof import("../packages/desktop/src/main/desktop-services").switchGitBranch;
let dir: string;

async function run(args: string[], cwd = dir): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout;
}

beforeAll(async () => {
  const services = await import("../packages/desktop/src/main/desktop-services");
  getGitBranches = services.getGitBranches;
  switchGitBranch = services.switchGitBranch;
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codeshell-git-branches-"));
  await run(["init", "-b", "main"]);
  await run(["config", "user.email", "test@example.com"]);
  await run(["config", "user.name", "Test User"]);
  await writeFile(join(dir, "README.md"), "hello\n");
  await run(["add", "README.md"]);
  await run(["commit", "-m", "initial"]);
  await run(["branch", "feature/local"]);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("getGitBranches lists local branches and current branch", async () => {
  const branches = await getGitBranches(dir);

  expect(branches.isRepo).toBe(true);
  expect(branches.current).toBe("main");
  expect(branches.branches).toEqual(["feature/local", "main"]);
});

test("getGitBranches reports non-Git directories without throwing", async () => {
  const plain = await mkdtemp(join(tmpdir(), "codeshell-not-git-"));
  try {
    const branches = await getGitBranches(plain);

    expect(branches).toEqual({ isRepo: false, current: null, branches: [] });
  } finally {
    await rm(plain, { recursive: true, force: true });
  }
});

test("switchGitBranch switches only to an existing local branch", async () => {
  const branches = await switchGitBranch(dir, "feature/local");

  expect(branches.current).toBe("feature/local");
  expect((await run(["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("feature/local");
});

test("switchGitBranch rejects missing branches and keeps current branch", async () => {
  await expect(switchGitBranch(dir, "origin/remote-only")).rejects.toThrow(
    "Local branch not found",
  );

  expect((await run(["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("main");
});
