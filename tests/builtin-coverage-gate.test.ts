import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assertBunTestCompletion } from "../scripts/bun-test-completion.mjs";
import {
  assertCoverage,
  runCoverageProcess,
  summarizeCoverage,
} from "../scripts/check-builtin-coverage.js";

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

test("coverage child receives ordinary output files and preserves large diagnostics and failure", () => {
  const directory = mkdtempSync(join(tmpdir(), "builtin-coverage-output-"));
  try {
    const result = runCoverageProcess(
      directory,
      [
        "-e",
        'import { fstatSync, writeSync } from "node:fs";' +
          "if (!fstatSync(1).isFile() || !fstatSync(2).isFile()) process.exit(9);" +
          'writeSync(1, "stdout:" + "o".repeat(256 * 1024));' +
          'writeSync(2, "stderr:" + "e".repeat(256 * 1024));' +
          "process.exitCode = 7;",
      ],
      directory,
      15_000,
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(7);
    expect(readFileSync(join(directory, "stdout.log"), "utf8")).toBe(
      "stdout:" + "o".repeat(256 * 1024),
    );
    expect(readFileSync(join(directory, "stderr.log"), "utf8")).toBe(
      "stderr:" + "e".repeat(256 * 1024),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("source coverage excludes generated package copies while retaining every loaded source", () => {
  const directory = mkdtempSync(join(tmpdir(), "builtin-coverage-population-"));
  try {
    const config = Bun.TOML.parse(
      readFileSync(new URL("../bunfig.coverage.toml", import.meta.url), "utf8"),
    ) as { test: { coverageSkipTestFiles: boolean; coveragePathIgnorePatterns: string[] } };
    writeFileSync(
      join(directory, "bunfig.toml"),
      `[test]\ncoverageSkipTestFiles = ${config.test.coverageSkipTestFiles}\n` +
        `coveragePathIgnorePatterns = ${JSON.stringify(config.test.coveragePathIgnorePatterns)}\n`,
    );
    const sources = [
      "src/main.ts",
      "packages/core/src/main.ts",
      "packages/core/src/dist/handwritten.ts",
    ];
    const generated = ["dist/main.js", "packages/core/dist/main.js"];
    for (const file of [...sources, ...generated]) {
      const path = join(directory, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        'export function visited() { return "visited"; }\n' +
          'export function unvisited() { return "unvisited"; }\n',
      );
    }
    writeFileSync(
      join(directory, "population.test.ts"),
      'import { expect, test } from "bun:test";\n' +
        [...sources, ...generated]
          .map((file, index) => `import { visited as visit${index} } from "./${file}";`)
          .join("\n") +
        '\ntest("actual source and generated copies both execute", () => {\n' +
        [...sources, ...generated]
          .map((_, index) => `expect(visit${index}()).toBe("visited");`)
          .join("\n") +
        "\n});\n",
    );
    const coverage = join(directory, "coverage");
    const report = join(directory, "junit.xml");
    const result = runCoverageProcess(
      directory,
      [
        "test",
        "--config=./bunfig.toml",
        "--coverage",
        "--coverage-reporter=text",
        "--coverage-reporter=lcov",
        `--coverage-dir=${coverage}`,
        "--reporter=junit",
        `--reporter-outfile=${report}`,
        "./population.test.ts",
      ],
      directory,
      15_000,
    );
    expect(result.error).toBeUndefined();
    expect(result.status, readFileSync(join(directory, "stderr.log"), "utf8")).toBe(0);
    assertBunTestCompletion(report);
    const lcov = readFileSync(join(coverage, "lcov.info"), "utf8");
    const measured = [...lcov.matchAll(/^SF:(.+)$/gm)].map((match) =>
      match[1].replaceAll("\\", "/"),
    );
    for (const file of sources)
      expect(measured.some((path) => path === file || path.endsWith(`/${file}`))).toBe(true);
    for (const file of generated)
      expect(measured.some((path) => path === file || path.endsWith(`/${file}`))).toBe(false);
    const totals = summarizeCoverage(lcov);
    expect(totals.files).toBe(sources.length);
    expect(totals.functionCoverage).toBe(0.5);
    expect(assertCoverage(totals)).toContain("minimum 45%");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
