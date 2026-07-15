#!/usr/bin/env node
// Headless no-account web host CLI. See serve/cli.ts.
import { runServeCli } from "../serve/cli.js";

runServeCli().catch((error) => {
  console.error(`[serve] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
