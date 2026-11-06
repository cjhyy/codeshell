import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BrowserPanelAccessPrompt } from "../../preload/browser-panel-access-api";
import type { BrowserRuntimeHandoffStatus } from "../../preload/types";

/** An AI request can offer a target; only the user's click selects its exact guest. */
export function useBrowserPanelAccessPrompt({
  engineSessionId,
  bucket,
  partition,
  activeId,
  guestId,
  url,
  select,
}: {
  engineSessionId: string | null | undefined;
  bucket: string | undefined;
  partition: string | undefined;
  activeId: string;
  guestId: number | undefined;
  url: string;
  select: (guestId: number) => Promise<BrowserRuntimeHandoffStatus | null>;
}) {
  const scope = useMemo(
    () => ({ engineSessionId, bucket, partition, activeId, guestId, url }),
    [engineSessionId, bucket, partition, activeId, guestId, url],
  );
  const currentScope = useRef<typeof scope | null>(scope);
  currentScope.current = scope;
  type Request = { prompt: BrowserPanelAccessPrompt; scope: typeof scope; answering: boolean };
  const current = useRef<Request | null>(null);
  const [request, setRequest] = useState<Request | null>(null);
  const [busy, setBusy] = useState(false);
  const finish = useCallback((pending: Request, granted: boolean) => {
    if (current.current !== pending) return;
    current.current = null;
    setRequest(null);
    setBusy(false);
    window.codeshell.browserPanelAccess?.respond(pending.prompt.requestId, granted);
  }, []);

  useEffect(() => {
    currentScope.current = scope;
    const unsubscribe = window.codeshell.browserPanelAccess?.onRequest((prompt) => {
      if (currentScope.current !== scope || !engineSessionId || guestId === undefined) return;
      if (prompt.sessionId !== engineSessionId || prompt.guestId !== guestId) return;
      if (current.current?.prompt.requestId === prompt.requestId) return;
      if (current.current) finish(current.current, false);
      const next = { prompt, scope, answering: false };
      current.current = next;
      if (prompt.expiresAt <= Date.now()) finish(next, false);
      else setRequest(next);
    });
    return () => {
      unsubscribe?.();
      if (current.current?.scope === scope) finish(current.current, false);
      if (currentScope.current === scope) currentScope.current = null;
    };
  }, [engineSessionId, guestId, scope, finish]);

  useEffect(() => {
    if (!request) return;
    const timer = setTimeout(
      () => finish(request, false),
      Math.max(0, request.prompt.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [request, finish]);

  const answer = useCallback(
    async (allow: boolean) => {
      if (!request || current.current !== request || request.answering) return;
      const valid = () =>
        currentScope.current === request.scope && request.prompt.expiresAt > Date.now();
      if (!allow || !valid() || request.scope.guestId === undefined) {
        finish(request, false);
        return;
      }
      request.answering = true;
      setBusy(true);
      try {
        const status = await select(request.scope.guestId);
        finish(
          request,
          Boolean(valid() && status?.granted && status.guestId === request.scope.guestId),
        );
      } catch {
        finish(request, false);
      }
    },
    [request, select, finish],
  );

  return {
    prompt: request?.scope === scope ? request.prompt : null,
    busy: request?.scope === scope && busy,
    answer,
  };
}
