export type DesktopShutdownChoice = "retry" | "quit" | "cancel";

/** Only the initial save can return to a fully usable application. */
export function desktopShutdownFailureDialog(canCancel: boolean) {
  return {
    type: "warning" as const,
    title: "CodeShell 无法完成退出",
    message: canCancel ? "保存未完成。" : "清理未完成。",
    detail: canCancel
      ? "重试可再次保存。选择仍然退出可能丢失未保存内容。"
      : "部分服务已关闭，无法取消本次退出。重试可再次完成当前清理步骤；选择仍然退出可能留下未完成的清理。",
    buttons: canCancel ? ["重试", "取消退出", "仍然退出"] : ["重试", "仍然退出"],
    defaultId: 0,
    cancelId: canCancel ? 1 : 0,
  };
}
export function desktopShutdownDialogChoice(
  response: number,
  canCancel: boolean,
): DesktopShutdownChoice {
  if (canCancel) return response === 0 ? "retry" : response === 2 ? "quit" : "cancel";
  return response === 1 ? "quit" : "retry";
}

/** Once disposal starts, every outcome proceeds toward quit rather than reopening disposed services. */
export function createDesktopShutdownHandler(deps: {
  ownsInstance(): boolean;
  flushRenderers(): Promise<unknown>;
  disposeOperationResolution(): Promise<unknown>;
  cleanup(): Promise<unknown>;
  /** Close the persistence worker only after every remaining service cleanup was attempted. */
  finalize?(): Promise<unknown>;
  quit(): void;
  cancelQuit?(): void;
  onError(phase: string, error: unknown): void;
  resolveFailure?(
    phase: string,
    error: unknown,
    options: { canCancel: boolean },
  ): Promise<DesktopShutdownChoice>;
}): (event: { preventDefault(): void }) => void {
  let pending: Promise<void> | undefined;
  let done = false;
  const steps = [
    ["session.quit_save_failed", deps.flushRenderers],
    ["operation_review.shutdown_unproven", deps.disposeOperationResolution],
    ["desktop.shutdown_failed", deps.cleanup],
    ["session.quit_close_failed", () => deps.finalize?.()],
  ] as const;
  return (event) => {
    if (!deps.ownsInstance() || done) return;
    event.preventDefault();
    if (pending) return;
    pending = Promise.resolve().then(async () => {
      for (let index = 0; index < steps.length; index++) {
        const [phase, run] = steps[index]!;
        const canCancel = index === 0;
        try {
          await run();
        } catch (error) {
          deps.onError(phase, error);
          const fallback = canCancel ? "cancel" : "quit";
          const choice =
            (await deps.resolveFailure?.(phase, error, { canCancel }).catch(() => fallback)) ??
            fallback;
          if (choice === "retry") {
            index--;
            continue;
          }
          // Enforce the boundary even if a stale UI adapter returns "cancel".
          if (choice === "quit" || !canCancel) continue;
          deps.cancelQuit?.();
          pending = undefined;
          return;
        }
      }
      done = true;
      deps.quit();
    });
  };
}

/** Keep native window/quit wiring and failure choices outside the composition root. */
export function registerDesktopShutdown(
  app: { on(event: string, listener: (...args: any[]) => void): unknown; quit(): void },
  deps: Omit<Parameters<typeof createDesktopShutdownHandler>[0], "quit" | "resolveFailure"> & {
    showFailureDialog(
      options: ReturnType<typeof desktopShutdownFailureDialog>,
    ): Promise<{ response: number }>;
    restoreMainWindow(): Promise<unknown>;
    platform?: NodeJS.Platform;
  },
): void {
  app.on("window-all-closed", () => {
    if (deps.ownsInstance() && (deps.platform ?? process.platform) !== "darwin") app.quit();
  });
  app.on(
    "before-quit",
    createDesktopShutdownHandler({
      ...deps,
      quit: () => app.quit(),
      resolveFailure: async (_phase, _error, { canCancel }) => {
        const { response } = await deps.showFailureDialog(desktopShutdownFailureDialog(canCancel));
        return desktopShutdownDialogChoice(response, canCancel);
      },
    }),
  );
  app.on("activate", () => {
    if (deps.ownsInstance())
      void deps.restoreMainWindow().catch((error) => deps.onError("window.restore_failed", error));
  });
}
