/** Native quit stays blocked until saves/cleanup succeed or the user chooses to quit. */
export function createDesktopShutdownHandler(deps: {
  ownsInstance(): boolean;
  flushRenderers(): Promise<unknown>;
  disposeOperationResolution(): Promise<unknown>;
  cleanup(): Promise<unknown>;
  quit(): void;
  onError(phase: string, error: unknown): void;
  resolveFailure?(phase: string, error: unknown): Promise<"retry" | "quit" | "cancel">;
}): (event: { preventDefault(): void }) => void {
  let pending: Promise<void> | undefined;
  let done = false;
  const steps = [
    ["session.quit_save_failed", deps.flushRenderers],
    ["operation_review.shutdown_unproven", deps.disposeOperationResolution],
    ["desktop.shutdown_failed", deps.cleanup],
  ] as const;
  return (event) => {
    if (!deps.ownsInstance() || done) return;
    event.preventDefault();
    if (pending) return;
    pending = Promise.resolve().then(async () => {
      for (let index = 0; index < steps.length; index++) {
        const [phase, run] = steps[index]!;
        try {
          await run();
        } catch (error) {
          deps.onError(phase, error);
          const choice =
            (await deps.resolveFailure?.(phase, error).catch(() => "cancel" as const)) ?? "cancel";
          if (choice === "retry") {
            index--;
            continue;
          }
          if (choice === "quit") continue; // still attempt every remaining cleanup step
          pending = undefined;
          return;
        }
      }
      done = true;
      deps.quit();
    });
  };
}
