import type { HookRegistry } from "../hooks/registry.js";
import type { HookHandler } from "../hooks/registry.js";
import { FileHistory } from "../session/file-history.js";
import type { RunScopedDisposer } from "./run-types.js";
import type { CapabilityFileHistoryContribution } from "../capabilities/index.js";

export interface RegisterFileHistoryHookOptions {
  hooks: Pick<HookRegistry, "register" | "unregister">;
  sessionDir: string;
  cwd: string;
  getTurnSeq: () => number | undefined;
  contributions?: readonly CapabilityFileHistoryContribution[];
}

export function registerFileHistoryHook(
  options: RegisterFileHistoryHookOptions,
): RunScopedDisposer {
  const history = FileHistory.loadFromDir(options.sessionDir);
  const pendingCreates = new Map<string, ReturnType<FileHistory["prepareCreated"]>>();
  const startHandler: HookHandler = async (context) => {
    const toolName = context.data?.toolName as string;
    const args = context.data?.args as Record<string, unknown> | undefined;
    const toolCallId = context.data?.toolCallId;
    const turnSeq = options.getTurnSeq();
    if ((toolName === "Write" || toolName === "Edit") && typeof args?.file_path === "string") {
      const marker =
        turnSeq === undefined ? null : history.prepareCreated(args.file_path, turnSeq);
      if (marker && typeof toolCallId === "string") {
        pendingCreates.set(toolCallId, marker);
      } else {
        history.saveSnapshot(args.file_path, turnSeq);
      }
    } else if (args) {
      const contribution = options.contributions?.find((item) => item.toolName === toolName);
      for (const target of contribution?.resolveTargets(args, options.cwd) ?? []) {
        history.saveSnapshot(target, turnSeq);
      }
    }
    return {};
  };
  const endHandler: HookHandler = async (context) => {
    const toolCallId = context.data?.toolCallId;
    if (typeof toolCallId !== "string") return {};
    const marker = pendingCreates.get(toolCallId);
    pendingCreates.delete(toolCallId);
    if (marker && context.data?.isError !== true) history.commitCreated(marker);
    return {};
  };
  options.hooks.register("on_tool_start", startHandler, 100, "file_history_backup");
  options.hooks.register("on_tool_end", endHandler, 100, "file_history_backup");

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      pendingCreates.clear();
      options.hooks.unregister("on_tool_start", startHandler);
      options.hooks.unregister("on_tool_end", endHandler);
    },
  };
}
