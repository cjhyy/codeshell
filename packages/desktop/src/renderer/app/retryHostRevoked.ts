import { DesktopHostErrors } from "../../shared/desktop-host-protocol";

/** Backoff for reads the Host withdrew while a session changed hands. An
 * external runtime can take several seconds to claim its first window, so the
 * total (~12 s) covers a cold Claude Code or Codex start. */
const REVOKED_READ_RETRY_DELAYS_MS = [100, 250, 500, 1000, 2000, 4000, 4000] as const;

/**
 * The Host withdraws a read when session ownership changes under it. A new
 * session reaches that state on its first send: the window claims it while the
 * hydration's unowned disk read is in flight, before its directory exists.
 * That is not damaged history. The preload formats Host RPC errors as
 * `${message} (${code})`, and only the message crosses the context bridge.
 */
export function isHostRevokedError(error: unknown): boolean {
  if ((error as { code?: unknown } | null)?.code === DesktopHostErrors.revoked) return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.endsWith(`(${DesktopHostErrors.revoked})`);
}

/** Retries `read` after a revoked-read error while `canContinue` holds. */
export async function retryHostRevoked<T>(
  read: () => Promise<T>,
  canContinue: () => boolean,
  delays: readonly number[] = REVOKED_READ_RETRY_DELAYS_MS,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (attempt >= delays.length || !isHostRevokedError(error) || !canContinue()) throw error;
      await wait(delays[attempt]!);
      if (!canContinue()) throw error;
    }
  }
}
