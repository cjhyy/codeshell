import { SettingsManager } from "@cjhyy/code-shell-core";
import {
  discoverRecentClaudeSessions,
  discoverRecentCodexSessions,
  parseClaudeTranscriptLine,
  parseCodexTranscriptLine,
} from "@cjhyy/code-shell-capability-coding/orchestration";
import { resolveNoRepoCwd } from "../../main/no-repo-cwd.js";
import { ExternalSessionAdapter } from "../../main/pet/external-session-adapter.js";
import { ExternalSessionVisibilityController } from "../../main/pet/external-session-visibility.js";
import type { DesktopPetSession } from "../../main/pet/pet-state-aggregator.js";
import { dlog } from "../../main/desktop-logger.js";

/** Lives in the history worker. Only the bounded activity rows reach the native pet view. */
export function createMimiExternalActivity(changed: () => void) {
  const rows = new Map<string, DesktopPetSession>();
  let projectCwds: string[] = [];
  let signalled = false;
  const notify = () => {
    if (signalled) return;
    signalled = true;
    changed();
  };
  const removeExternalSession = (id: string) => {
    if (rows.delete(id)) notify();
  };
  const scopeSettings = (cwd: string, scope: "user" | "project") =>
    new SettingsManager(cwd, "full").getForScope(
      scope,
      scope === "project" ? cwd : undefined,
    ) as Record<string, unknown>;
  const controller = new ExternalSessionVisibilityController({
    readUserSettings: () => scopeSettings(resolveNoRepoCwd(), "user"),
    readProjectSettings: (cwd) => scopeSettings(cwd, "project"),
    listProjectCwds: async () => projectCwds,
    createAdapter: (cli, getScope, includeSession) => {
      const discover = cli === "codex" ? discoverRecentCodexSessions : discoverRecentClaudeSessions;
      return new ExternalSessionAdapter({
        cli,
        discover: () => discover({ sinceMs: 24 * 60 * 60_000, limit: 50 }, undefined, getScope()),
        parseLine: cli === "codex" ? parseCodexTranscriptLine : parseClaudeTranscriptLine,
        includeSession,
        sink: {
          upsertExternalSession(row) {
            rows.set(row.agentSessionId, row);
            notify();
          },
          removeExternalSession,
        },
        onBackgroundError: (operation, error) =>
          dlog("main", `pet.external.${cli}.${operation}.failed`, { error: String(error) }),
      });
    },
    onSourceDisabled: (cli) => {
      for (const [id, row] of rows) if (row.external?.cli === cli) removeExternalSession(id);
    },
    onReconcileError: (cli, error) =>
      dlog("main", `pet.external.${cli}.reconcile.failed`, { error: String(error) }),
  });
  return {
    async snapshot(input: { projectCwds?: string[] }) {
      if (input.projectCwds) {
        projectCwds = input.projectCwds;
        await controller.reconcile();
      }
      signalled = false;
      return [...rows.values()];
    },
    close: () => controller.shutdown(),
  };
}
