import { useEffect, useState, type ReactNode } from "react";
import { useT } from "./i18n";
import { WindowTitleBar } from "./app/WindowTitleBar";
import {
  flushSessionPersistence,
  initializeSessionPersistence,
  subscribeSessionPersistenceErrors,
} from "./sessionPersistence";

/** Never mount an empty sidebar while its authoritative directory is loading. */
export function SessionPersistenceGate({ children }: { children: ReactNode }) {
  const { t } = useT();
  const [ready, setReady] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    let live = true;
    setFailed(false);
    void initializeSessionPersistence().then(
      () => live && setReady(true),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [attempt]);
  useEffect(() => subscribeSessionPersistenceErrors(() => setFailed(true)), []);
  useEffect(() => window.codeshell.sessionCatalog?.onFlushRequested?.(flushSessionPersistence), []);

  const retry = async () => {
    if (!ready) {
      setAttempt((value) => value + 1);
      return;
    }
    setRetrying(true);
    try {
      await flushSessionPersistence();
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setRetrying(false);
    }
  };
  const retryButton = (
    <button
      type="button"
      className="shrink-0 rounded border border-border px-3 py-1 disabled:opacity-50"
      disabled={retrying}
      onClick={() => void retry()}
    >
      {t("misc.session.retry")}
    </button>
  );
  if (!ready) {
    return (
      <div className="flex h-screen flex-col bg-background text-sm text-foreground">
        <WindowTitleBar />
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6">
          <p role={failed ? "alert" : "status"}>
            {t(failed ? "misc.session.loadFailed" : "misc.session.loading")}
          </p>
          {failed && retryButton}
        </div>
      </div>
    );
  }
  return (
    <>
      {children}
      {failed && (
        <div
          role="alert"
          className="fixed inset-x-4 z-[90] flex items-center justify-center gap-3 rounded-md border border-border bg-popover p-3 text-sm text-popover-foreground shadow-lg"
          style={{ top: "max(3rem, env(titlebar-area-height, 0px))" }}
        >
          <span>{t("misc.session.saveFailed")}</span>
          {retryButton}
        </div>
      )}
    </>
  );
}
