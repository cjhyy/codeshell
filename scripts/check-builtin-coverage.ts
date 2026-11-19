import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertBunTestCompletion, createBunTestEnvironment } from "./bun-test-completion.mjs";

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

/** Keep Bun's coverage finalization independent of a busy CI output pipe. */
export function runCoverageProcess(
  directory: string,
  args: string[],
  cwd: string,
  timeout?: number,
) {
  const stdout = openSync(join(directory, "stdout.log"), "wx", 0o600);
  let stderr: number | undefined;
  try {
    stderr = openSync(join(directory, "stderr.log"), "wx", 0o600);
    return spawnSync(process.execPath, args, {
      cwd,
      env: createBunTestEnvironment(process.env, directory),
      stdio: ["inherit", stdout, stderr],
      timeout,
    });
  } finally {
    closeSync(stdout);
    if (stderr !== undefined) closeSync(stderr);
  }
}

function main(): number {
  const directory = mkdtempSync(join(tmpdir(), "codeshell-builtin-coverage-"));
  try {
    // Bun 1.3.11's text reporter can return before committing LCOV when a
    // console write fails. Ordinary files keep that write out of the CI pipe;
    // replay the diagnostics only after the child has finalized its reports.
    const result = runCoverageProcess(
      directory,
      [
        "test",
        "--timeout",
        "30000",
        "--config=./bunfig.coverage.toml",
        "packages/core/src/tool-system/builtin",
        "packages/core/src/tool-system/testing",
        // Skill execution now selects retained project packages. Include its
        // real installation/migration/path checks, already listed in the builtin
        // coverage matrix, instead of measuring these imported helpers untested.
        "packages/core/src/panel-apps/package-snapshots.test.ts",
        "packages/core/src/tool-system/path-policy-panel-skill.test.ts",
        // LinkAction's production write consumer now owns a durable operation
        // claim and permission-gated readback. Exercise that real builtin path
        // and its concurrent/restart states in the same coverage harness.
        "packages/core/src/links/verified-write.test.ts",
        "packages/core/src/operations",
        // Bash permission classification loads the read-redirect classifier;
        // measure it with its own approval-level tests.
        "packages/core/src/tool-system/permission-bash-redirects.test.ts",
        "--coverage",
        "--coverage-reporter=text",
        "--coverage-reporter=lcov",
        `--coverage-dir=${directory}`,
        "--reporter=junit",
        `--reporter-outfile=${join(directory, "junit.xml")}`,
      ],
      fileURLToPath(new URL("..", import.meta.url)),
    );
    process.stdout.write(readFileSync(join(directory, "stdout.log")));
    process.stderr.write(readFileSync(join(directory, "stderr.log")));
    if (result.error) throw result.error;
    if (result.status !== 0) return result.status ?? 1;
    assertBunTestCompletion(join(directory, "junit.xml"));
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
