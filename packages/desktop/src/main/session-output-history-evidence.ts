import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { codeShellHome } from "@cjhyy/code-shell-core";
import type { OutputHistoryRecoveryEvidence } from "@cjhyy/code-shell-core/internal";
import { SessionCatalogStore } from "./session-catalog-store.js";

/** Resolve every persisted UI alias from Main metadata, never from client paths. */
export async function outputHistoryCacheEvidence(
  sessionId: string,
  projectId: string | null,
): Promise<OutputHistoryRecoveryEvidence[]> {
  const keys = new Set([JSON.stringify([projectId ?? "__no_repo__", sessionId])]);
  const catalog = await new SessionCatalogStore().load();
  for (const [projectKey, index] of Object.entries(catalog.indices))
    for (const row of index.sessions)
      if ((row.engineSessionId ?? row.id) === sessionId)
        keys.add(JSON.stringify([projectKey, row.id]));
  const files: OutputHistoryRecoveryEvidence[] = [];
  for (const key of keys) {
    const hash = createHash("sha256").update(key).digest("hex");
    for (const [prefix, directory] of [
      ["current", "transcript-cache"],
      ["legacy", "legacy-transcript-cache"],
    ]) {
      const path = join(codeShellHome(), "desktop", directory!, hash + ".json");
      if (existsSync(path)) files.push({ path, name: `${prefix}-${hash.slice(0, 40)}.json` });
    }
  }
  return files;
}
