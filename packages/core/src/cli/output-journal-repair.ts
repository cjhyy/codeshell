#!/usr/bin/env node
/** Explicit filesystem-only maintenance; no default HOME, Engine, provider, or network bootstrap. */
import { isAbsolute } from "node:path";
import {
  backupOutputJournal,
  inspectOutputJournalRepair,
  restoreOutputJournalBackup,
} from "../session/output-journal-manual-repair.js";
import { migrateOutputJournalIdentity } from "../session/output-journal-identity-migration.js";

try {
  const [command, root, sessionId, destination, ...extra] = process.argv.slice(2);
  if (
    !root ||
    !isAbsolute(root) ||
    !sessionId ||
    !["inspect", "backup", "restore", "migrate-identity"].includes(command ?? "") ||
    (command === "inspect"
      ? destination !== undefined
      : !destination || !isAbsolute(destination)) ||
    (command === "migrate-identity"
      ? extra.some(
          (flag) => !["--accept-legacy-identity", "--resume-with-recorded-gap"].includes(flag),
        ) || new Set(extra).size !== extra.length
      : extra.length > 0)
  )
    throw new Error(
      "Usage: code-shell-output-journal inspect <absolute-sessions-root> <session-id> | backup <absolute-sessions-root> <session-id> <new-absolute-bundle-dir> | restore <absolute-sessions-root> <session-id> <absolute-bundle-dir> | migrate-identity <absolute-sessions-root> <session-id> <new-absolute-evidence-dir> --accept-legacy-identity [--resume-with-recorded-gap]",
    );
  const result =
    command === "inspect"
      ? inspectOutputJournalRepair(root, sessionId)
      : command === "backup"
        ? backupOutputJournal(root, sessionId, destination!)
        : command === "restore"
          ? restoreOutputJournalBackup(root, sessionId, destination!)
          : migrateOutputJournalIdentity(root, sessionId, destination!, {
              acceptLegacyIdentity: extra.includes("--accept-legacy-identity"),
              resumeWithRecordedGap: extra.includes("--resume-with-recorded-gap"),
            });
  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  process.stderr.write(
    `Output journal maintenance refused${code ? ` (${code})` : ""}: ${error instanceof Error ? error.message : "unknown failure"}\n`,
  );
  process.exitCode = 1;
}
