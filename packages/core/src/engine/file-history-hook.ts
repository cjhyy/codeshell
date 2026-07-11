import type { HookRegistry } from "../hooks/registry.js";
import type { HookHandler } from "../hooks/registry.js";
import { FileHistory } from "../session/file-history.js";
import { patchBackupTargets } from "../tool-system/builtin/apply-patch/backup-targets.js";
import type { RunScopedDisposer } from "./run-types.js";

export interface RegisterFileHistoryHookOptions {
  hooks: Pick<HookRegistry, "register" | "unregister">;
  sessionDir: string;
  cwd: string;
  getTurnSeq: () => number | undefined;
}

export function registerFileHistoryHook(
  options: RegisterFileHistoryHookOptions,
): RunScopedDisposer {
  const history = FileHistory.loadFromDir(options.sessionDir);
  const handler: HookHandler = async (context) => {
    const toolName = context.data?.toolName as string;
    const args = context.data?.args as Record<string, unknown> | undefined;
    const turnSeq = options.getTurnSeq();
    if ((toolName === "Write" || toolName === "Edit") && typeof args?.file_path === "string") {
      if (history.saveSnapshot(args.file_path, turnSeq) === null && turnSeq !== undefined) {
        history.recordCreated(args.file_path, turnSeq);
      }
    } else if (toolName === "ApplyPatch" && typeof args?.patch === "string") {
      for (const target of patchBackupTargets(args.patch, options.cwd)) {
        history.saveSnapshot(target, turnSeq);
      }
    }
    return {};
  };
  options.hooks.register("on_tool_start", handler, 100, "file_history_backup");

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      options.hooks.unregister("on_tool_start", handler);
    },
  };
}
