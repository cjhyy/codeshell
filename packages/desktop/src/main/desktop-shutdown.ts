/** Native quit stays blocked until renderer saves and constrained child cleanup succeed. */
export function createDesktopShutdownHandler(deps: {
  ownsInstance(): boolean;
  flushRenderers(): Promise<unknown>;
  disposeOperationResolution(): Promise<unknown>;
  cleanup(): Promise<unknown>;
  quit(): void;
  onError(phase: string, error: unknown): void;
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
    // Schedule after assigning pending, including synchronously throwing adapters.
    pending = Promise.resolve().then(async () => {
      for (const [phase, run] of steps) {
        try {
          await run();
        } catch (error) {
          pending = undefined;
          deps.onError(phase, error);
          return;
        }
      }
      done = true;
      deps.quit();
    });
  };
}
