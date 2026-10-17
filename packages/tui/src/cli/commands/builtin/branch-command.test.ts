import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandContext } from "../registry.js";
import { gitCommands } from "./git-commands.js";

const branch = gitCommands.find((command) => command.name === "/branch")!;
let root: string;
let repository: string;
const git = (...args: string[]): string =>
  execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    timeout: 5000,
    stdio: "pipe",
  }).trim();

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "codeshell-branch-command-")));
  repository = join(root, "repository");
  const template = join(root, "empty-template");
  mkdirSync(repository);
  mkdirSync(template);
  git("init", "--quiet", "--initial-branch=main", `--template=${template}`);
  git("config", "core.hooksPath", join(root, "absent-hooks"));
  git("config", "commit.gpgsign", "false");
  git("config", "user.name", "Owned branch command fixture");
  git("config", "user.email", "branch-command@example.invalid");
  git("commit", "--quiet", "--allow-empty", "-m", "Owned branch baseline");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function context(cwd = repository) {
  const statuses: string[] = [];
  // /branch needs no client, model, QueryGuard or session authority.
  const ctx = new Proxy(
    { cwd, addStatus: (message: string) => statuses.push(message) } as CommandContext,
    {
      get(target, key) {
        if (key !== "cwd" && key !== "addStatus")
          throw Error(`Unexpected branch context access: ${String(key)}`);
        return Reflect.get(target, key);
      },
    },
  );
  return { ctx, statuses };
}

describe("TUI /branch creation tokens with owned real Git", () => {
  for (const name of ["feature-cache", "feature--create"]) {
    test(`switches to ${name} without creating or rewriting its bytes`, async () => {
      git("branch", name);
      const before = git("for-each-ref", "--format=%(refname)", "refs/heads");
      const { ctx, statuses } = context();
      await branch.execute(name, ctx);
      expect(git("branch", "--show-current")).toBe(name);
      expect(git("for-each-ref", "--format=%(refname)", "refs/heads")).toBe(before);
      expect(statuses).toEqual([`Switched to branch: ${name}`]);
    });
  }

  test("switches an ordinary branch with only outer whitespace removed", async () => {
    git("branch", "topic");
    const { ctx, statuses } = context();
    await branch.execute(" \ttopic  ", ctx);
    expect(git("branch", "--show-current")).toBe("topic");
    expect(statuses).toEqual(["Switched to branch: topic"]);
  });

  for (const [arg, name] of [
    ["-c feature-cache", "feature-cache"],
    ["feature--create -c", "feature--create"],
    ["--create feature-cache", "feature-cache"],
    ["feature--create --create", "feature--create"],
  ]) {
    test(`creates exactly the requested branch for ${arg}`, async () => {
      const { ctx, statuses } = context();
      await branch.execute(arg, ctx);
      expect(git("branch", "--show-current")).toBe(name);
      expect(git("for-each-ref", "--format=%(refname)", "refs/heads").split("\n")).toEqual([
        `refs/heads/${name}`,
        "refs/heads/main",
      ]);
      expect(statuses).toEqual([`Switched to branch: ${name} (created)`]);
    });
  }

  test("recognizes complete flags separated by tabs and repeated whitespace", async () => {
    const { ctx, statuses } = context();
    await branch.execute("\t--create \t-c\tfeature-cache \t", ctx);
    expect(git("branch", "--show-current")).toBe("feature-cache");
    expect(statuses).toEqual(["Switched to branch: feature-cache (created)"]);
  });

  test("lists branches when the argument is empty", async () => {
    git("branch", "feature-cache");
    const { ctx, statuses } = context();
    await branch.execute(" \t ", ctx);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toStartWith("Branches:\n");
    expect(statuses[0]).toContain("feature-cache");
    expect(statuses[0]).toContain("* main");
    expect(git("branch", "--show-current")).toBe("main");
  });

  test("an unborn repository has an empty branch list", async () => {
    git("update-ref", "-d", "refs/heads/main");
    const { ctx, statuses } = context();
    await branch.execute("", ctx);
    expect(statuses).toEqual(["Branches:\n"]);
    expect(git("for-each-ref", "refs/heads")).toBe("");
  });

  test("a missing create name reports the existing validation error without creating a ref", async () => {
    for (const arg of ["-c", "--create", "-c --create"]) {
      const { ctx, statuses } = context();
      await branch.execute(arg, ctx);
      expect(statuses).toEqual(["Branch operation failed: branch must be a non-empty string"]);
      expect(git("branch", "--show-current")).toBe("main");
      expect(git("for-each-ref", "--format=%(refname)", "refs/heads")).toBe("refs/heads/main");
    }
  });

  test("a missing branch remains a failed switch and never becomes a creation", async () => {
    const { ctx, statuses } = context();
    await branch.execute("missing-cache", ctx);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toStartWith("Branch operation failed:");
    expect(git("branch", "--show-current")).toBe("main");
    expect(git("for-each-ref", "--format=%(refname)", "refs/heads")).toBe("refs/heads/main");
  });

  test("an existing create target reports Git failure without changing refs", async () => {
    const { ctx, statuses } = context();
    await branch.execute("main --create", ctx);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toStartWith("Branch operation failed:");
    expect(git("branch", "--show-current")).toBe("main");
    expect(git("for-each-ref", "--format=%(refname)", "refs/heads")).toBe("refs/heads/main");
  });

  test("a flag prefix is still rejected as a leading-dash branch name", async () => {
    const { ctx, statuses } = context();
    await branch.execute("-create-topic", ctx);
    expect(statuses).toEqual([
      "Branch operation failed: refusing branch name that starts with '-': -create-topic",
    ]);
    expect(git("for-each-ref", "--format=%(refname)", "refs/heads")).toBe("refs/heads/main");
  });

  test("a non-repository reports the existing error without requesting any context authority", async () => {
    const { ctx, statuses } = context(root);
    await branch.execute("feature-cache", ctx);
    expect(statuses).toEqual(["Not a git repository."]);
    expect(git("branch", "--show-current")).toBe("main");
  });
});
