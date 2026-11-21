import type { CronJob, CreateJobOptions } from "@cjhyy/code-shell-core/internal";
import type {
  AutomationSummary,
  CreateAutomationInput,
  UpdateAutomationInput,
} from "../../main/automation-service.js";
import type { PanelAutomationScope } from "@cjhyy/code-shell-server/panels";

export interface CronCalls {
  list: { input: undefined; result: AutomationSummary[] };
  get: { input: string; result: AutomationSummary | null };
  create: { input: CreateAutomationInput; result: AutomationSummary };
  update: {
    input: { id: string; patch: UpdateAutomationInput; scope?: { resumeSessionId: string } };
    result: AutomationSummary | null;
  };
  forSession: { input: string; result: AutomationSummary[] };
  delete: { input: string; result: boolean };
  pause: { input: string; result: boolean };
  resume: { input: string; result: boolean };
  runNow: { input: string; result: boolean };
  cancel: { input: string; result: boolean };
  reload: { input: undefined; result: void };
  template: {
    input: {
      installKey: string;
      templateId: string;
      expectedRevision: string;
      workspace: string | { cwd?: string; projectId?: string; rootId?: string };
    };
    result: AutomationSummary;
  };
  panel: {
    input: {
      grantId: string;
      scope: Pick<PanelAutomationScope, "appId" | "cwd" | "sessionId" | "revision">;
      method: string;
      params?: unknown;
    };
    result: unknown;
  };
  petList: { input: undefined; result: CronJob[] };
  petCreate: {
    input: { name: string; schedule: string; prompt: string; options: CreateJobOptions };
    result: CronJob;
  };
  petDelete: { input: string; result: boolean };
}

export type CronCommand = {
  [K in keyof CronCalls]: { method: K; input: CronCalls[K]["input"] };
}[keyof CronCalls];
