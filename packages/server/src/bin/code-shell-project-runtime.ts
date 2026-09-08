#!/usr/bin/env node
import { runManagedProjectEntry } from "../project-runtime/managed-entry.js";

runManagedProjectEntry().catch(() => {
  // Secret-file parsing and credential validation can contain private values in
  // their underlying errors. Expose only the operational failure to Docker logs.
  console.error(
    "[project-runtime] initialization failed; check this project's runtime configuration.",
  );
  process.exit(1);
});
