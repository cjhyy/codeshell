#!/usr/bin/env bun
/**
 * Dev harness: launch the CodeShell UI with a synthetic N-message
 * transcript pre-loaded. Used for manual scroll / perf testing.
 *
 *   bun run dev:bigtranscript [count] [TUI options]
 *
 * Default count: 10000.
 */

const args = process.argv.slice(2);
const countArg = args[0] && !args[0].startsWith("-") ? args.shift() : undefined;
const count = Number(countArg ?? 10_000);
if (!Number.isSafeInteger(count) || count <= 0) {
  throw new Error("Transcript count must be a positive safe integer.");
}
// The optional count belongs to this harness, not the CLI command parser.
process.argv = [process.argv[0]!, process.argv[1]!, ...args];
process.env.CODESHELL_DEV_SEED_TRANSCRIPT = String(count);
process.env.CODESHELL_UI_PERF = process.env.CODESHELL_UI_PERF ?? "1";
process.env.CODE_SHELL_DEV = "1";

await import("../packages/tui/src/cli/main.js");
