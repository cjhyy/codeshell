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
  cwd?: string,
): AutomationSummary {
  return automationSummary(
    instantiatePluginAutomationTemplate({
      scheduler: requireAutomationScheduler(),
      installKey,
      templateId,
      expectedRevision,
      ...(cwd ? { cwd } : {}),
      disabledPluginNames: disabledPluginNames(cwd ?? process.cwd()),
    }),
  );
}
