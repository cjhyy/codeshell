import { join } from "node:path";
import { userHome, writeSettingsSchemaFile } from "@cjhyy/code-shell-core";
import {
  cleanupAttachments,
  cleanupSessionAttachments,
  cleanupStaleQuickChatSessions,
} from "@cjhyy/code-shell-server/storage";
import { loadProjects } from "../../main/recents-store.js";
import { resolveNoRepoCwd } from "../../main/no-repo-cwd.js";
import { assertDesktopSessionId } from "../../main/session-validation.js";
import type { BusinessMethods } from "./business-calls.js";

async function knownWorkspaces(): Promise<string[]> {
  const workspaces = new Set<string>();
  for (const project of await loadProjects().catch(() => [])) {
    if (typeof project.path === "string" && project.path) workspaces.add(project.path);
  }
  workspaces.add(resolveNoRepoCwd());
  return [...workspaces];
}

/** Private, first-instance maintenance. No caller chooses a filesystem root. */
export const startupOperations = {
  "startup/workspaces": knownWorkspaces,
  "startup/settingsSchema"() {
    writeSettingsSchemaFile(join(userHome(), ".code-shell"));
  },
  "startup/quickChats": () => cleanupStaleQuickChatSessions(),
  async "startup/cleanupAttachments"({ sessionId }, grant) {
    if (sessionId !== undefined) assertDesktopSessionId(sessionId);
    for (const cwd of await knownWorkspaces()) {
      grant.assertCurrent();
      const cleanup = sessionId
        ? cleanupSessionAttachments(cwd, sessionId)
        : cleanupAttachments({ cwd });
      await cleanup.catch(() => undefined);
    }
  },
} satisfies Pick<
  BusinessMethods,
  | "startup/workspaces"
  | "startup/settingsSchema"
  | "startup/quickChats"
  | "startup/cleanupAttachments"
>;
