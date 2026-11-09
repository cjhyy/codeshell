/**
 * Project tool tasks (`tasks.*`): validates the installed native entry, asks for
 * saved-login consent before a start/retry, and forwards to PanelToolJobService
 * within the guest's app/project/revision scope.
 */
import {
  PanelBridgeError,
  type ToolJob,
  type ToolQueueUpdate,
} from "@cjhyy/code-shell-server/panels";
import type { GuestBinding, PanelAppBridgeInternals } from "./panel-app-bridge-types.js";

/** Task events and listings never carry the task's input or result payloads. */
export function panelToolJobSummary(job: ToolJob) {
  const { input: _input, result: _result, ...summary } = job;
  return summary;
}

export async function panelDispatchToolJobs(
  bridge: PanelAppBridgeInternals,
  binding: GuestBinding,
  method: string,
  params: unknown,
) {
  bridge.requirePermission(binding, "process");
  bridge.requirePermission(binding, "resources");
  await bridge.trustedWorkspaceRoot(binding);
  const scope = {
    appId: binding.resource.descriptor.appId,
    projectPath: binding.projectPath,
    revision: binding.resource.descriptor.revision,
  };
  const input = (params ?? {}) as {
    id?: string;
    entry?: string;
    input?: unknown;
    recovery?: "manual" | "retry";
    requestKey?: string;
    offset?: number;
    limit?: number;
  };
  const service = bridge.getToolJobService();
  if (method === "tasks.start") {
    const entry = (await bridge.installedToolApp(scope)).nativeEntries?.[input.entry ?? ""];
    if (!entry) throw new PanelBridgeError("NOT_SUPPORTED", "Installed native tool is unavailable");
    await bridge.confirmTaskCookie(binding, input.input, input.entry!);
    return service.start(scope, {
      entry: { name: input.entry!, sha256: entry.sha256 },
      input: input.input,
      recovery: input.recovery ?? "manual",
      requestKey: input.requestKey,
    });
  }
  if (method === "tasks.find") return service.find(scope, input.requestKey!);
  if (method === "tasks.queue.get") return service.getQueue(scope);
  if (method === "tasks.queue.set") return service.setQueue(scope, params as ToolQueueUpdate);
  if (method === "tasks.list") {
    const offset = input.offset ?? 0,
      limit = input.limit ?? 50;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      throw new PanelBridgeError("INVALID_ARGUMENT", "Invalid task page");
    return (await service.list(scope))
      .slice(offset, offset + limit)
      .map((job) => panelToolJobSummary(job));
  }
  if (method === "tasks.get") return service.get(scope, input.id!);
  if (method === "tasks.cancel") return service.cancel(scope, input.id!);
  if (method === "tasks.retry") {
    const previous = await service.get(scope, input.id!);
    if (previous.readOnly)
      throw new PanelBridgeError("NOT_SUPPORTED", "旧任务仅供查看，请检查输入后创建新任务。");
    await bridge.confirmTaskCookie(binding, previous.input, previous.entry.name);
    return service.retry(scope, input.id!);
  }
  throw new PanelBridgeError("NOT_SUPPORTED", "Unknown tool task operation");
}
