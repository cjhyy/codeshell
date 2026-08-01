// Guard: every literal test path referenced by a GitHub workflow must exist.
//
// WHY THIS EXISTS
// ---------------
// The `tests (targeted)` job in ci.yml lists individual test files instead of
// running the whole suite. When a test file is renamed, the workflow keeps
// pointing at the old name and `bun test` exits 1 with only:
//   error: "packages/…/plugin-panel-protocol.test.ts" did not match any test files
// That reads like a genuine test failure, so the real cause (a stale path in
// CI config, not broken code) is easy to misdiagnose. It shipped exactly that
// way: the Panel App migration renamed plugin-panel-protocol.test.ts to
// panel-app-protocol.test.ts and ci.yml was never updated.
//
// Run this BEFORE the test job so a stale path fails loudly and locally.
//
// Only *literal* paths are checked. Globs (`packages/chat/src/*.test.ts`) are
// skipped — a glob legitimately matches nothing at some commits, and bun does
// not treat an empty glob as an error the way it does an unmatched literal.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflowDir = resolve(repoRoot, ".github/workflows");

// A path-shaped token under packages/ or tests/ ending in a test extension.
const TEST_PATH = /(?:packages|tests)\/[A-Za-z0-9_./-]*\.test\.(?:ts|tsx|mjs|js)/g;

let missing = 0;
let checked = 0;

for (const file of readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f))) {
  const workflowPath = resolve(workflowDir, file);
  const contents = readFileSync(workflowPath, "utf8");

  for (const match of new Set(contents.match(TEST_PATH) ?? [])) {
    // Skip globs; only literal paths give bun's hard "did not match" error.
    if (match.includes("*")) continue;
    checked += 1;
    if (!existsSync(resolve(repoRoot, match))) {
      missing += 1;
      // eslint-disable-next-line no-console
      console.error(`✗ ${file}: referenced test file does not exist → ${match}`);
    }
  }
}

if (missing > 0) {
  // eslint-disable-next-line no-console
  console.error(
    `\n${missing} stale test path(s) in .github/workflows. ` +
      `Update the workflow to the current filename (or delete the entry if the test is gone).`,
  );
  process.exit(1);
}

// eslint-disable-next-line no-console
console.log(`✓ ${checked} literal workflow test paths all exist`);
