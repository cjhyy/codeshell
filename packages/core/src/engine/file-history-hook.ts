import type { HookRegistry } from "../hooks/registry.js";
import type { HookHandler } from "../hooks/registry.js";
import { FileHistory } from "../session/file-history.js";
import type { RunScopedDisposer } from "./run-types.js";
import type { CapabilityFileHistoryContribution } from "../capabilities/index.js";
import { resolve } from "node:path";
import { TurnDiffTracker } from "../session/turn-diff.js";
import type { TurnDiffSnapshot } from "../types.js";

export interface RegisterFileHistoryHookOptions {
  hooks: Pick<HookRegistry, "register" | "unregister">;
  sessionDir: string;
  cwd: string;
  getTurnSeq: () => number | undefined;
  contributions?: readonly CapabilityFileHistoryContribution[];
  /** Ephemeral runs still publish file evidence without creating persistent history. */
  ephemeral?: boolean;
  /** Final execution observation, after formatter/file_changed hooks have settled. */
  observeCompletion?: (
    observer: (toolCallId: string, isError: boolean) => void | Promise<void>,
  ) => () => void;
  turnDiff?: {
    turnId: string;
    onUpdate(snapshot: TurnDiffSnapshot): void | Promise<void>;
  };
}

export function registerFileHistoryHook(
  options: RegisterFileHistoryHookOptions,
): RunScopedDisposer & { publishInitial(): Promise<void> } {
  const history = options.ephemeral ? undefined : FileHistory.loadFromDir(options.sessionDir);
  const diff = options.turnDiff
    ? new TurnDiffTracker({
        turnId: options.turnDiff.turnId,
        cwd: options.cwd,
        ...(options.ephemeral ? {} : { sessionDir: options.sessionDir }),
      })
    : undefined;
  const pendingCreates = new Map<string, ReturnType<FileHistory["prepareCreated"]>>();
  const startHandler: HookHandler = async (context) => {
    const toolName = context.data?.toolName as string;
    const args = context.data?.args as Record<string, unknown> | undefined;
    const toolCallId = context.data?.toolCallId;
    const turnSeq = options.getTurnSeq();
    const contribution = options.contributions?.find((item) => item.toolName === toolName);
    const directPath =
      (toolName === "Write" || toolName === "Edit") && typeof args?.file_path === "string"
        ? resolve(options.cwd, args.file_path)
        : undefined;
    if (args && typeof toolCallId === "string") {
      const targets = directPath
        ? [directPath]
        : ((contribution?.resolveDiffTargets ?? contribution?.resolveTargets)?.(
            args,
            options.cwd,
          ) ?? []);
      if (targets.length) diff?.begin(toolCallId, targets);
    }
    if (!history) return {};
    if ((toolName === "Write" || toolName === "Edit") && typeof args?.file_path === "string") {
      const marker = turnSeq === undefined ? null : history.prepareCreated(directPath!, turnSeq);
      if (marker && typeof toolCallId === "string") {
        pendingCreates.set(toolCallId, marker);
      } else {
        history.saveSnapshot(directPath!, turnSeq);
      }
    } else if (args) {
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
    if (marker && context.data?.isError !== true) history?.commitCreated(marker);
    if (!options.observeCompletion) await publishDiff(toolCallId, context.data?.isError === true);
    return {};
  };
  const publishDiff = async (toolCallId: string, isError: boolean) => {
    const completed = diff?.end(toolCallId, !isError);
    const snapshot = diff?.refresh() ?? completed;
    if (snapshot) await options.turnDiff?.onUpdate(snapshot);
  };
  const removeObserver = options.observeCompletion?.(publishDiff);
  const removeStart = options.hooks.register(
    "on_tool_start",
    startHandler,
    100,
    "file_history_backup",
  );
  const removeEnd = options.hooks.register("on_tool_end", endHandler, 100, "file_history_backup");

  let disposed = false;
  return {
    async publishInitial() {
      const snapshot = diff?.current();
      if (snapshot) await options.turnDiff?.onUpdate(snapshot);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pendingCreates.clear();
      removeObserver?.();
      void removeEnd();
      void removeStart();
    },
  };
}
