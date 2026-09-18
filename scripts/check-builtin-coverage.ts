import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MIN_LINES = 0.45;
const MIN_FUNCTIONS = 0.38;

export interface CoverageSummary {
  files: number;
  lines: number;
  coveredLines: number;
  functions: number;
  coveredFunctions: number;
  lineCoverage: number;
  functionCoverage: number;
}

/** Match Bun's "All files" mean of module ratios, using exact LCOV counts. */
export function summarizeCoverage(lcov: string): CoverageSummary {
  const totals: CoverageSummary = {
    files: 0,
    lines: 0,
    coveredLines: 0,
    functions: 0,
    coveredFunctions: 0,
    lineCoverage: 0,
    functionCoverage: 0,
  };
  let record: Partial<Record<"LF" | "LH" | "FNF" | "FNH", number>> | undefined;
  for (const line of lcov.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      if (record) throw new Error("Incomplete LCOV record");
      record = {};
    } else if (/^(LF|LH|FNF|FNH):/.test(line)) {
      const [key, raw] = line.split(":") as [keyof NonNullable<typeof record>, string];
      const count = Number(raw);
      if (!record || !/^\d+$/.test(raw) || !Number.isSafeInteger(count) || key in record) {
        throw new Error("Invalid LCOV count");
      }
      record[key] = count;
    } else if (line === "end_of_record") {
      if (
        !record ||
        record.LF === undefined ||
        record.LH === undefined ||
        record.FNF === undefined ||
        record.FNH === undefined ||
        record.LH > record.LF ||
        record.FNH > record.FNF
      )
        throw new Error("Incomplete or inconsistent LCOV record");
      totals.files++;
      totals.lines += record.LF;
      totals.coveredLines += record.LH;
      totals.functions += record.FNF;
      totals.coveredFunctions += record.FNH;
      totals.lineCoverage += record.LF ? record.LH / record.LF : 1;
      totals.functionCoverage += record.FNF ? record.FNH / record.FNF : 1;
      record = undefined;
    }
  }
  if (record || !totals.files || !totals.lines || !totals.functions) {
    throw new Error("Coverage report is missing or incomplete");
  }
  totals.lineCoverage /= totals.files;
  totals.functionCoverage /= totals.files;
  return totals;
}

export function assertCoverage(totals: CoverageSummary): string {
  const lines = totals.lineCoverage;
  const functions = totals.functionCoverage;
  const message =
    `Builtin module-average coverage: ${(lines * 100).toFixed(2)}% lines ` +
    `(minimum ${MIN_LINES * 100}%), ${(functions * 100).toFixed(2)}% functions ` +
    `(minimum ${MIN_FUNCTIONS * 100}%), ${totals.files} files`;
  if (
    !Number.isFinite(lines) ||
    !Number.isFinite(functions) ||
    lines < MIN_LINES ||
    functions < MIN_FUNCTIONS
  ) {
    throw new Error(message);
  }
  return message;
}

function main(): number {
  const directory = mkdtempSync(join(tmpdir(), "codeshell-builtin-coverage-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        "test",
        "--timeout",
        "30000",
        "--config=./bunfig.coverage.toml",
        "packages/core/src/tool-system/builtin",
        "packages/core/src/tool-system/testing",
        "--coverage",
        "--coverage-reporter=text",
        "--coverage-reporter=lcov",
        `--coverage-dir=${directory}`,
      ],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        stdio: "inherit",
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) return result.status ?? 1;
    console.log(
      assertCoverage(summarizeCoverage(readFileSync(join(directory, "lcov.info"), "utf8"))),
    );
    return 0;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
