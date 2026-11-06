/**
 * Explicit review maintenance only; never invoked by tests or builds.
 * Reads owning contribution data without running a tool, provider or connection.
 *
 *   bun run scripts/update-external-tool-review.ts
 *   bun run scripts/update-external-tool-review.ts --check
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BUILTIN_TOOLS } from "../packages/core/src/tool-system/builtin/index.js";
import { createExternalToolReviewSnapshot } from "../packages/core/src/tool-system/external-tool-exposure.js";
import { CODING_TOOLS } from "../packages/coding/src/index.capability.js";
import { EXTERNAL_GOAL_TOOL_CATALOG } from "../packages/desktop/src/main/external-runtime-goal-tools.js";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
  throw new Error("Usage: bun run scripts/update-external-tool-review.ts [--check]");
}

// Mirrors Desktop's actual composition and the full-catalog review test:
// Host Goal controllers replace native acknowledgement-only implementations.
const catalog = [
  ...new Map(
    [...BUILTIN_TOOLS, ...CODING_TOOLS, ...EXTERNAL_GOAL_TOOL_CATALOG].map((tool) => [
      tool.definition.name,
      tool,
    ]),
  ).values(),
];
const snapshot = createExternalToolReviewSnapshot(catalog);
const output = `${JSON.stringify(snapshot, null, 2)}\n`;
const path = fileURLToPath(
  new URL("../packages/core/src/tool-system/external-tool-exposure.reviewed.json", import.meta.url),
);
const current = readFileSync(path, "utf8");
if (current === output) {
  console.log(`External tool review already matches all ${snapshot.length} declarations.`);
} else if (args[0] === "--check") {
  console.error(
    "External tool review differs from the owning declarations. Update and review the diff.",
  );
  process.exitCode = 1;
} else {
  writeFileSync(path, output);
  console.log(
    `Updated ${snapshot.length} external tool review entries. Review the snapshot diff before committing.`,
  );
}
