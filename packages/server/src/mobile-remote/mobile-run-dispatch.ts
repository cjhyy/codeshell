export interface MobileRunBridge {
  subscribeOutbound(listener: (line: string) => void): () => void;
  injectWorkerMessage(line: string): void;
}

export interface MobileRunRequest {
  id: string;
  params: Record<string, unknown>;
}

export type MobileRunAcceptance = { ok: true } | { ok: false; message: string; code?: number };

/** Inject agent/run and wait for its request-correlated validation/queue acknowledgement. */
export function injectMobileRunAndAwaitAcceptance(
  bridge: MobileRunBridge,
  request: MobileRunRequest,
  timeoutMs = 5_000,
): Promise<MobileRunAcceptance> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: MobileRunAcceptance): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      resolve(result);
    };
    const unsubscribe = bridge.subscribeOutbound((line) => {
      try {
        const message = JSON.parse(line) as {
          id?: unknown;
          method?: unknown;
          params?: { requestId?: unknown };
          result?: unknown;
          error?: { message?: unknown; code?: unknown };
        };
        if (message.method === "agent/runAccepted" && message.params?.requestId === request.id) {
          finish({ ok: true });
          return;
        }
        if (message.id !== request.id) return;
        if (message.error) {
          finish({
            ok: false,
            message:
              typeof message.error.message === "string"
                ? message.error.message
                : "worker rejected the run",
            ...(typeof message.error.code === "number" ? { code: message.error.code } : {}),
          });
        } else if ("result" in message) {
          // Compatibility fallback if an older/embedded worker completes before
          // emitting the explicit acknowledgement.
          finish({ ok: true });
        }
      } catch {
        // Not JSON or not part of this request.
      }
    });
    timer = setTimeout(
      () => finish({ ok: false, message: "worker did not acknowledge the run" }),
      timeoutMs,
    );
    try {
      bridge.injectWorkerMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          method: "agent/run",
          params: request.params,
        }),
      );
    } catch (error) {
      finish({ ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  });
}
