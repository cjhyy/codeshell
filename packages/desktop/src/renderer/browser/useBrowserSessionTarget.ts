import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BrowserRuntimeHandoffStatus } from "../../preload/types";

/** A selection belongs to one mounted Session/bucket/profile, never a later render. */
export function useBrowserSessionTarget(
  sessionId: string | null | undefined,
  bucket: string | undefined,
  partition: string | undefined,
) {
  const scope = useMemo(() => ({ sessionId, bucket, partition }), [sessionId, bucket, partition]);
  const current = useRef<typeof scope | null>(scope);
  current.current = scope;
  const revision = useRef(0);
  const pending = useRef<typeof scope | null>(null);
  const [state, setState] = useState<{
    scope: typeof scope;
    status: BrowserRuntimeHandoffStatus;
    busy?: boolean;
    error?: string;
    unavailable?: boolean;
  }>({ scope, status: { granted: false, sessionId: sessionId ?? "" } });
  const status =
    state.scope === scope ? state.status : { granted: false, sessionId: sessionId ?? "" };

  useEffect(() => {
    current.current = scope;
    let cancelled = false;
    let polling = false;
    const refresh = async () => {
      if (!sessionId || pending.current === scope || polling) return;
      polling = true;
      const requestRevision = revision.current;
      try {
        const next = await window.codeshell.getBuiltInBrowserRuntimeHandoff(sessionId);
        if (cancelled || current.current !== scope || revision.current !== requestRevision) return;
        if (next.sessionId !== sessionId) return;
        setState((previous) => ({
          scope,
          status: next,
          error: previous.scope === scope ? previous.error : undefined,
        }));
      } catch {
        if (cancelled || current.current !== scope || revision.current !== requestRevision) return;
        // Failure to check is not a revocation. Keep the exact selected guest
        // alive while reporting uncertainty; Main still validates every action.
        setState((previous) => ({
          scope,
          status: previous.scope === scope ? previous.status : { granted: false, sessionId },
          unavailable: true,
        }));
      } finally {
        polling = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      if (current.current === scope) current.current = null;
    };
  }, [scope, sessionId]);

  const update = useCallback(
    async (guestId?: number) => {
      if (!sessionId || current.current !== scope || pending.current === scope) return;
      if (
        guestId !== undefined &&
        status.granted &&
        status.guestId === guestId &&
        status.expiresAt === undefined &&
        !state.unavailable
      )
        return;
      pending.current = scope;
      const requestRevision = ++revision.current;
      setState({ scope, status, busy: true });
      try {
        const next =
          guestId === undefined
            ? await window.codeshell.revokeBuiltInBrowserFromRuntime(sessionId)
            : await window.codeshell.grantBuiltInBrowserToRuntime({
                sessionId,
                guestId,
                lifetime: "session",
              });
        if (current.current !== scope || revision.current !== requestRevision) return;
        if (next.sessionId !== sessionId)
          throw new Error("browser selection belongs to another session");
        setState({ scope, status: next });
      } catch (error) {
        if (current.current !== scope || revision.current !== requestRevision) return;
        setState({ scope, status, error: error instanceof Error ? error.message : String(error) });
      } finally {
        if (pending.current === scope) pending.current = null;
      }
    },
    [scope, sessionId, state.unavailable, status],
  );

  return {
    status,
    busy: state.scope === scope && Boolean(state.busy),
    error: state.scope === scope ? state.error : undefined,
    unavailable: state.scope === scope && Boolean(state.unavailable),
    select: (guestId: number) => update(guestId),
    revoke: () => update(),
  };
}
