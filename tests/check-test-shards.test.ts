import { expect, test } from "bun:test";
import {
  checkShards,
  newInProcessBundlers,
  workflowProcesses,
} from "../scripts/check-test-shards.ts";

const workflow = {
  jobs: {
    tests: {
      strategy: {
        matrix: {
          include: [
            {
              shard: "a",
              paths: "packages/a tests",
              ignore: "--path-ignore-patterns '**/a/slow/**'",
            },
            { shard: "b", paths: "packages/b" },
          ],
        },
      },
      steps: [
        {
          run: "node scripts/run-bun-test-shard.mjs --timeout 30000 ${{ matrix.ignore }} ${{ matrix.paths }}",
        },
        {
          name: "slow alone",
          run: "node scripts/run-bun-test-shard.mjs --timeout 30000 packages/a/slow\nnode other.mjs",
        },
      ],
    },
  },
};

test("matrix shards expand per entry and separate steps are their own processes", () => {
  expect(workflowProcesses(workflow)).toEqual([
    { label: "tests (a)", paths: ["packages/a", "tests"], ignores: ["**/a/slow/**"] },
    { label: "tests (b)", paths: ["packages/b"], ignores: [] },
    { label: "tests: slow alone", paths: ["packages/a/slow"], ignores: [] },
  ]);
});

test("paths select subtrees, not substrings, and an ignored file must run elsewhere", () => {
  const processes = workflowProcesses(workflow).slice(0, 2);
  const result = checkShards(
    [
      "packages/a/x.test.ts",
      "packages/a/slow/y.test.ts",
      // A prefix of a listed path is a different directory.
      "packages/ab/z.test.ts",
      "packages/b/w.test.ts",
    ],
    processes,
    { "tests (a)": 1, "tests (b)": 1 },
  );
  expect(result.uncovered).toEqual(["packages/a/slow/y.test.ts", "packages/ab/z.test.ts"]);
  expect(result.oversized).toEqual([]);
});

test("a shard past its budget is reported with both numbers", () => {
  const result = checkShards(
    ["packages/b/1.test.ts", "packages/b/2.test.ts"],
    workflowProcesses(workflow),
    { "tests (b)": 1 },
  );
  expect(result.oversized).toEqual([{ label: "tests (b)", files: 2, budget: 1 }]);
});

test("only the known suites may bundle inside the test process", () => {
  // Split so this file is not itself an in-process bundler to the guard.
  const call = "await Bun." + "build({})";
  const sources: Record<string, string> = {
    "tests/plugins-installer-symlinks.test.ts": call,
    "tests/new.test.ts": call,
    "tests/helper-user.test.ts": "bundleInSubprocess([], dir)",
  };
  expect(newInProcessBundlers(Object.keys(sources), (file) => sources[file]!)).toEqual([
    "tests/new.test.ts",
  ]);
});
