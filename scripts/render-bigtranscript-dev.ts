#!/usr/bin/env bun
/**
 * Dev harness: launch the CodeShell UI with a synthetic N-message
 * transcript pre-loaded. Used for manual scroll / perf testing.
 *
 *   bun run dev:bigtranscript [count]
 *
 * Default count: 10000.
 */

const count = Number(process.argv[2] ?? 10000);
process.env.CODESHELL_DEV_SEED_TRANSCRIPT = String(count);
process.env.CODESHELL_UI_PERF = process.env.CODESHELL_UI_PERF ?? "1";
process.env.CODE_SHELL_DEV = "1";

await import("../src/cli/main.js");
