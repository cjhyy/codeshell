import { instantiatePluginAutomationTemplate, SettingsManager } from "@cjhyy/code-shell-core";
import { computeEffectiveDisabledLists } from "@cjhyy/code-shell-core/internal";
import {
  automationSummary,
  requireAutomationScheduler,
  type AutomationSummary,
} from "./automation-service.js";

function disabledPluginNames(cwd: string): Set<string> {
  return new Set(
    computeEffectiveDisabledLists(
      new SettingsManager(cwd || process.cwd(), "full"),
      cwd || undefined,
    ).disabledPlugins,
  );
}

/**
 * Materialize one installed plugin template into the user's automation store.
 * The caller supplies only stable identifiers, the reviewed revision and an
 * optional current cwd. Prompt, schedule and permission are re-read from the
 * trusted canonical manifest. Installation itself never creates jobs.
 */
export function createAutomationFromPluginTemplate(
  installKey: string,
  templateId: string,
  expectedRevision: string,
  workspace: string | { cwd?: string; projectId?: string; rootId?: string } = {},
): AutomationSummary {
  const normalizedWorkspace = typeof workspace === "string" ? { cwd: workspace } : workspace;
  return automationSummary(
    instantiatePluginAutomationTemplate({
      scheduler: requireAutomationScheduler(),
      installKey,
      templateId,
      expectedRevision,
      ...normalizedWorkspace,
      disabledPluginNames: disabledPluginNames(normalizedWorkspace.cwd ?? process.cwd()),
    }),
  );
}
