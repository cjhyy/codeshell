import { expect, test } from "bun:test";
import { localTestPlan } from "../scripts/run-unit-tests";
test("the local runner preserves CI matrix exclusions and each dedicated process", () => {
  const plan = localTestPlan({
    jobs: {
      tests: {
        strategy: {
          matrix: {
            include: [
              {
                shard: "one",
                paths: "packages/one",
                ignore: "--path-ignore-patterns '**/slow/**'",
              },
              { shard: "two", paths: "tests packages/two" },
            ],
          },
        },
        steps: [
          {
            run: "node scripts/run-bun-test-shard.mjs --timeout 30000 ${{ matrix.ignore }} ${{ matrix.paths }}",
          },
          {
            name: "slow",
            run: "node scripts/run-bun-test-shard.mjs --timeout 30000 packages/one/slow",
          },
        ],
      },
    },
  });
  expect(plan).toEqual([
    {
      label: "tests (one)",
      args: ["--timeout", "30000", "--path-ignore-patterns", "**/slow/**", "packages/one"],
    },
    { label: "tests (two)", args: ["--timeout", "30000", "tests", "packages/two"] },
    { label: "tests: slow", args: ["--timeout", "30000", "packages/one/slow"] },
  ]);
});
