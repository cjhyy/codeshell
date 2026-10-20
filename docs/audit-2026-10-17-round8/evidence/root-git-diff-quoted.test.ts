import { afterAll, expect, mock, test } from "bun:test";

let nativeCalls = 0;
const forbidden = () => { nativeCalls++; throw new Error("Native process forbidden in this audit fixture"); };
mock.module("node:child_process", () => ({
  exec: forbidden, execSync: forbidden, execFile: forbidden, execFileSync: forbidden,
  spawn: forbidden, spawnSync: forbidden, fork: forbidden,
}));

let status = "";
let committed = "";
let calls: string[][] = [];
mock.module("../../../packages/coding/src/git/worktree/git-exec.js", () => ({
  gitOutput: async (_cwd: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "rev-parse") return "abcdef1234\n";
    if (args[0] === "status") return status;
    if (args[0] === "diff") return committed;
    if (args[0] === "rev-list") return "1\n";
    throw new Error(`Unexpected command shape: ${JSON.stringify(args)}`);
  },
}));
const { getWorktreeDiff } = await import("../../../packages/coding/src/git/worktree/diff.ts");
afterAll(() => mock.restore());

async function summarize(dirty: string, history: string) {
  status = dirty; committed = history; calls = [];
  const result = await getWorktreeDiff("/owned-memory-worktree", "main");
  expect(nativeCalls).toBe(0);
  expect(calls.some((args) => args.join(" ") === "diff --name-only main...HEAD")).toBe(true);
  return result;
}

test("unquoted ASCII same-file control deduplicates dirty and committed changes", async () => {
  expect(await summarize(" M file.txt\n", "file.txt\n")).toEqual({
    baseRef: "main", changedFiles: 1, aheadCommits: 1, hasUncommittedChanges: true,
  });
});

test("Git default C-quoted UTF-8 path counts one changed file twice", async () => {
  const quoted = '"' + Array.from(Buffer.from("中文.txt")).map((byte) =>
    byte >= 128 ? String.fromCharCode(92) + byte.toString(8).padStart(3, "0") : String.fromCharCode(byte),
  ).join("") + '"';
  expect(await summarize(` M ${quoted}\n`, `${quoted}\n`)).toEqual({
    baseRef: "main", changedFiles: 2, aheadCommits: 1, hasUncommittedChanges: true,
  });
});

test("quoted ASCII filename also gets two identities rather than one", async () => {
  const quoted = JSON.stringify('quote"name.txt');
  expect(await summarize(` M ${quoted}\n`, `${quoted}\n`)).toEqual({
    baseRef: "main", changedFiles: 2, aheadCommits: 1, hasUncommittedChanges: true,
  });
});

test("distinct normal files control correctly totals two", async () => {
  expect(await summarize(" M dirty.txt\n", "committed.txt\n")).toEqual({
    baseRef: "main", changedFiles: 2, aheadCommits: 1, hasUncommittedChanges: true,
  });
});
