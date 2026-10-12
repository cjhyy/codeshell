#!/usr/bin/env node
/** Explicit filesystem-only maintenance; no default HOME, Engine, provider, or network bootstrap. */
import { isAbsolute } from "node:path";
import {
  backupOutputJournal,
  inspectOutputJournalRepair,
  restoreOutputJournalBackup,
} from "../session/output-journal-manual-repair.js";

try {
  const [command, root, sessionId, destination, ...extra] = process.argv.slice(2);
  if (
    !root ||
    !isAbsolute(root) ||
    !sessionId ||
    extra.length ||
    !["inspect", "backup", "restore"].includes(command ?? "") ||
    (command === "inspect" ? destination !== undefined : !destination || !isAbsolute(destination))
  )
    throw new Error(
      "Usage: code-shell-output-journal inspect <absolute-sessions-root> <session-id> | backup <absolute-sessions-root> <session-id> <new-absolute-bundle-dir> | restore <absolute-sessions-root> <session-id> <absolute-bundle-dir>",
    );
  const result =
    command === "inspect"
      ? inspectOutputJournalRepair(root, sessionId)
      : command === "backup"
        ? backupOutputJournal(root, sessionId, destination!)
        : restoreOutputJournalBackup(root, sessionId, destination!);
  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  process.stderr.write(
    `Output journal maintenance refused${code ? ` (${code})` : ""}: ${error instanceof Error ? error.message : "unknown failure"}\n`,
  );
  process.exitCode = 1;
}
