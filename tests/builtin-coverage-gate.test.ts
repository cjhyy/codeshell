import { expect, test } from "bun:test";
import { assertCoverage, summarizeCoverage } from "../scripts/check-builtin-coverage.js";

function record(
  file: string,
  lines: number,
  hitLines: number,
  functions: number,
  hitFunctions: number,
) {
  return `SF:${file}\nLF:${lines}\nLH:${hitLines}\nFNF:${functions}\nFNH:${hitFunctions}\nend_of_record\n`;
}

test("coverage matches Bun's module mean while keeping the original line/function thresholds", () => {
  const totals = summarizeCoverage(
    record("covered.ts", 100, 90, 100, 76) + record("uncovered.ts", 10, 0, 1, 0),
  );
  expect(totals).toEqual({
    files: 2,
    lines: 110,
    coveredLines: 90,
    functions: 101,
    coveredFunctions: 76,
    lineCoverage: 0.45,
    functionCoverage: 0.38,
  });
  expect(assertCoverage(totals)).toContain("45.00% lines");
  expect(() => assertCoverage(summarizeCoverage(record("below.ts", 100, 44, 100, 38)))).toThrow(
    "minimum 45%",
  );
  expect(() => assertCoverage(summarizeCoverage(record("below.ts", 100, 45, 100, 37)))).toThrow(
    "minimum 38%",
  );
});

test("coverage fails closed for absent, truncated, invalid or impossible LCOV counts", () => {
  for (const report of [
    "",
    "SF:missing.ts\nLF:100\n",
    "SF:missing.ts\nend_of_record\n",
    record("bad.ts", 10, 11, 2, 1),
    record("bad.ts", 10, 5, 2, 3),
    record("bad.ts", 10, Number.NaN, 2, 1),
    record("empty.ts", 0, 0, 0, 0),
  ])
    expect(() => summarizeCoverage(report)).toThrow();
});
