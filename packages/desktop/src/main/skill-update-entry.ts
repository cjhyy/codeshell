/**
 * IPC-facing wrapper for the GitHub skill update-check. Mirrors
 * `checkPluginUpdateEntry` in plugins-service.ts: a network round-trip the
 * renderer calls per-skill in the background AFTER the list renders, so it
 * never blocks the list — and it NEVER throws. Any failure (bad filePath,
 * unreadable sidecar, network error) resolves to a not-available result so a
 * stale row just shows no badge.
 */

import {
  checkSkillUpdate,
  updateSkillFromSource,
  type SkillUpdateCheck,
  type SkillUpdateResult,
} from "./github-skill-service.js";

/**
 * IPC-facing wrapper for the one-click skill update (the manual "update"
 * button). Mirrors `updatePluginEntry` in plugins-service.ts: a thin
 * pass-through with input validation that does NOT swallow errors — the
 * renderer alerts the user on reject. The atomic replace in
 * `updateSkillFromSource` keeps the old version on any failure.
 */
export async function updateSkillEntry(
  filePath: string,
): Promise<SkillUpdateResult> {
  if (typeof filePath !== "string" || !filePath) {
    throw new Error("updateSkillEntry requires a filePath");
  }
  return updateSkillFromSource(filePath);
}

export async function checkSkillUpdateEntry(
  filePath: string,
): Promise<SkillUpdateCheck> {
  if (typeof filePath !== "string" || !filePath) {
    return {
      filePath: String(filePath),
      updateAvailable: false,
      reason: "missing filePath",
    };
  }
  try {
    return await checkSkillUpdate(filePath);
  } catch (e) {
    return {
      filePath,
      updateAvailable: false,
      reason: String((e as Error)?.message ?? e),
    };
  }
}
