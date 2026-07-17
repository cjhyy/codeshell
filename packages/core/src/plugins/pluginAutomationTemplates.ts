import type { CronJob, CronScheduler } from "../automation/scheduler.js";
import { loadPluginAutomationTemplateContributions } from "./pluginCatalog.js";

export const MAX_PLUGIN_AUTOMATIONS = 256;

export interface InstantiatePluginAutomationTemplateOptions {
  scheduler: Pick<CronScheduler, "create" | "list">;
  installKey: string;
  templateId: string;
  expectedRevision: string;
  cwd?: string;
  /** Effective project/global disable list computed by the host for this cwd. */
  disabledPluginNames: ReadonlySet<string>;
  maxJobs?: number;
}

/**
 * Copy an installed plugin template into a standalone cron job. This never
 * runs during install/update and never trusts executable fields supplied by a
 * renderer or protocol client.
 */
export function instantiatePluginAutomationTemplate(
  options: InstantiatePluginAutomationTemplateOptions,
): CronJob {
  if (typeof options.installKey !== "string" || !options.installKey) {
    throw new Error("installKey is required");
  }
  if (typeof options.templateId !== "string" || !options.templateId) {
    throw new Error("templateId is required");
  }
  if (!/^[a-f0-9]{64}$/.test(options.expectedRevision)) {
    throw new Error("automation template revision is invalid");
  }

  const contribution = loadPluginAutomationTemplateContributions().find(
    (entry) => entry.installKey === options.installKey && entry.template.id === options.templateId,
  );
  if (!contribution) {
    throw new Error(`automation template not found: ${options.installKey}/${options.templateId}`);
  }
  if (contribution.template.workspace === "current" && !options.cwd) {
    throw new Error("this automation template requires a current project");
  }
  if (contribution.revision !== options.expectedRevision) {
    throw new Error("automation template changed after review; review it again before creating");
  }
  if (options.disabledPluginNames.has(contribution.pluginName)) {
    throw new Error(`plugin is disabled for this project: ${contribution.pluginName}`);
  }
  const maxJobs = options.maxJobs ?? MAX_PLUGIN_AUTOMATIONS;
  if (!Number.isSafeInteger(maxJobs) || maxJobs <= 0) {
    throw new Error("maxJobs must be a positive safe integer");
  }
  if (options.scheduler.list().length >= maxJobs) {
    throw new Error(`automation limit reached (${maxJobs})`);
  }

  const template = contribution.template;
  return options.scheduler.create(template.title.default, template.schedule, template.prompt, {
    ...(template.workspace === "current" && options.cwd ? { cwd: options.cwd } : {}),
    ...(template.timezone ? { timezone: template.timezone } : {}),
    permissionLevel: template.permissionLevel,
    templateSource: {
      installKey: options.installKey,
      templateId: options.templateId,
      revision: contribution.revision,
      ...(contribution.pluginVersion ? { pluginVersion: contribution.pluginVersion } : {}),
    },
  });
}
