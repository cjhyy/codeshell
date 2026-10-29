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

test("Panel partitions cover resource descendants once and report new omissions and overlaps", () => {
  const panel = "packages/server/src/panels";
  const files = [`${panel}/runtime.test.ts`, `${panel}/resources/uploads.test.ts`];
  const processes = [
    { label: "tests: runtime", paths: [files[0]!], ignores: [] },
    { label: "tests: resources", paths: [`${panel}/resources`], ignores: [] },
  ];
  expect(checkShards(files, processes)).toMatchObject({ uncovered: [], overlappingPanels: [] });
  expect(checkShards([...files, `${panel}/new.test.ts`], processes).uncovered).toEqual([
    `${panel}/new.test.ts`,
  ]);
  expect(
    checkShards(files, [
      ...processes,
      { label: "tests: stale broad selection", paths: [panel], ignores: [] },
    ]).overlappingPanels,
  ).toEqual([
    { file: files[0], processes: ["tests: runtime", "tests: stale broad selection"] },
    { file: files[1], processes: ["tests: resources", "tests: stale broad selection"] },
  ]);
});

test("Panel partitions have smaller explicit process budgets", () => {
  const label = "tests: test Hub Panel native processes";
  const files = Array.from(
    { length: 7 },
    (_, index) => `packages/server/src/panels/${index}.test.ts`,
  );
  expect(
    checkShards(files, [{ label, paths: ["packages/server/src/panels"], ignores: [] }]).oversized,
  ).toEqual([{ label, files: 7, budget: 6 }]);
});

test("renaming a Panel process cannot restore the general default budget", () => {
  const label = "tests: renamed Panel step";
  const files = Array.from(
    { length: 11 },
    (_, index) => `packages/server/src/panels/${index}.test.ts`,
  );
  expect(
    checkShards(files, [{ label, paths: ["packages/server/src/panels"], ignores: [] }]).oversized,
  ).toEqual([{ label, files: 11, budget: 10 }]);
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
