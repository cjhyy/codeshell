import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parseArgs, validateSuite, runSucceeded } from "../evals/harness/runner.mjs";

test("live invocation is explicit and all spending knobs are bounded", () => {
  expect(parseArgs([]).live).toBeUndefined();
  expect(parseArgs(["--live", "--trials", "2"])).toMatchObject({
    live: true,
    trials: 2,
    "max-requests": 30,
  });
  for (const args of [
    ["--trials", "0"],
    ["--trials", "100"],
    ["--max-requests", "NaN"],
    ["--max-output-tokens", "-1"],
    ["--timeout-ms", "Infinity"],
    ["--max-reported-cost-usd", "0"],
    ["--connection"],
    ["--live", "--live"],
    ["--unknown"],
  ]) {
    expect(() => parseArgs(args)).toThrow();
  }
});

test("real historical catalog has unique cases and resolvable regression paths", async () => {
  const suite = JSON.parse(
    await readFile(new URL("../evals/harness/cases.json", import.meta.url), "utf8"),
  );
  await expect(validateSuite(suite)).resolves.toBe(suite);
  expect(suite.cases).toHaveLength(15);
  expect(suite.cases.filter((item) => item.adapter === "desktop")).toHaveLength(5);
  const bad = structuredClone(suite);
  bad.cases[0].repositoryRegression = ["../outside"];
  await expect(validateSuite(bad)).rejects.toThrow("escapes");
  const duplicate = structuredClone(suite);
  duplicate.cases.push(duplicate.cases[0]);
  await expect(validateSuite(duplicate)).rejects.toThrow("duplicate");
});

test("CLI failure includes missing hard evidence and an enabled judge failure", () => {
  const result = {
    executionStatus: "passed",
    hardAssertions: [{ passed: true }],
    semantic: { status: "not_evaluated" },
  };
  expect(runSucceeded([result])).toBe(true);
  expect(runSucceeded([result], { judge: true })).toBe(false);
  result.semantic.status = "failed";
  expect(runSucceeded([result], { judge: true })).toBe(false);
  result.semantic.status = "passed";
  expect(runSucceeded([result], { judge: true })).toBe(true);
  result.hardAssertions[0].passed = null;
  expect(runSucceeded([result])).toBe(false);
  expect(runSucceeded([])).toBe(false);
});

test("renderer oracle source is explicit and preserved for live adapter selection", () => {
  expect(parseArgs(["--live", "--renderer-source-root", "/frozen/source"])).toMatchObject({
    live: true,
    "renderer-source-root": "/frozen/source",
  });
  expect(parseArgs([])["renderer-source-root"]).toBeUndefined();
  expect(() => parseArgs(["--renderer-source-root"])).toThrow();
});
