// Ratchet: ESLint warnings may go down, never up.
//
// WHY THIS EXISTS
// ---------------
// `bun run lint` is 0 errors / ~132 warnings. A pile that size stops being
// signal: a genuinely new warning scrolls past unnoticed among the pre-existing
// ones, so in practice nobody reads them and the count only grows.
//
// Cleaning all of them at once is not worth it — they are spread across dozens
// of files and most are cosmetic (unused type imports, ts-expect-error
// descriptions). What matters is that the number cannot increase. This gate
// fails when it does, and asks you to lower the baseline when it drops, so the
// pile can only shrink.
//
// Run: bun run lint:baseline

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselineFile = resolve(repoRoot, "scripts/lint-baseline.json");

const result = spawnSync("bunx", ["eslint", "packages/", "--format", "json"], {
  cwd: repoRoot,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});

// ESLint exits non-zero when there are ERRORS; warnings alone exit 0. Either way
// we need the JSON report, so only a missing/unparseable report is fatal.
let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  console.error("could not parse ESLint JSON output:");
  console.error(result.stdout.slice(0, 2_000));
  console.error(result.stderr.slice(0, 2_000));
  process.exit(1);
}

let warnings = 0;
let errors = 0;
for (const file of report) {
  warnings += file.warningCount ?? 0;
  errors += file.errorCount ?? 0;
}

const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));

if (errors > 0) {
  console.error(`✗ ${errors} ESLint error(s). Errors are never allowed.`);
  process.exit(1);
}

if (warnings > baseline.maxWarnings) {
  console.error(
    `✗ ESLint warnings went UP: ${warnings} (baseline ${baseline.maxWarnings}).\n` +
      `  Fix the new warning, or — if it is genuinely unavoidable — raise the\n` +
      `  baseline in scripts/lint-baseline.json in the same commit, with a reason.`,
  );
  process.exit(1);
}

if (warnings < baseline.maxWarnings) {
  // Lower it automatically so the ratchet cannot silently slip back up later.
  writeFileSync(baselineFile, `${JSON.stringify({ maxWarnings: warnings }, null, 2)}\n`);
  console.log(
    `✓ ESLint warnings dropped ${baseline.maxWarnings} → ${warnings}. ` +
      `Baseline lowered — commit scripts/lint-baseline.json.`,
  );
  process.exit(0);
}

console.log(`✓ ESLint: 0 errors, ${warnings} warnings (at baseline)`);
