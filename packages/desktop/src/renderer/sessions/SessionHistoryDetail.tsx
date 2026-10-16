import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { foldTranscript } from "../automation/foldTranscript";
import { MessageStream } from "../MessageStream";
import { useT } from "../i18n/I18nProvider";
import type { MessagesReducerState } from "../types";

const INITIAL_BYTES = 512 * 1024;
const MAX_BYTES = 8 * 1024 * 1024;

/** Read history without importing a legacy/archived session into an active workspace. */
export function SessionHistoryDetail({
  sessionId,
  title,
  onBack,
}: {
  sessionId: string;
  title: string;
  onBack: () => void;
}) {
  const { t } = useT();
  const [state, setState] = useState<MessagesReducerState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bytes, setBytes] = useState(INITIAL_BYTES);
  const [hasMore, setHasMore] = useState(false);
  const [revision, setRevision] = useState(0);
  const backRef = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(true);
  useLayoutEffect(() => backRef.current?.focus({ preventScroll: true }), []);
  useEffect(() => {
    let cancelled = false;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const page = window.codeshell.getSessionTranscriptPage
          ? await window.codeshell.getSessionTranscriptPage(sessionId, { maxBytes: bytes })
          : { items: await window.codeshell.getSessionTranscript(sessionId), hasMore: false };
        if (cancelled) return;
        setState(foldTranscript(page.items));
        setHasMore(page.hasMore);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) {
          inFlight.current = false;
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, bytes, revision]);
  const refresh = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRevision((value) => value + 1);
  };
  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col overflow-y-auto bg-muted/10"
      aria-label={t("activitySessions.viewRecord")}
    >
      <header className="flex shrink-0 flex-wrap items-start gap-3 border-b border-border/70 px-4 py-4 sm:px-6">
        <Button ref={backRef} type="button" variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft size={14} aria-hidden />
          {t("activitySessions.back")}
        </Button>
        <div className="min-w-0 flex-1 basis-40">
          <h1 className="break-words text-lg font-semibold [overflow-wrap:anywhere]">{title}</h1>
          <p className="mt-1 text-xs text-muted-foreground">{t("activitySessions.readOnly")}</p>
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{sessionId}</p>
        </div>
        <Button type="button" size="sm" variant="outline" aria-disabled={loading} onClick={refresh}>
          {loading ? (
            <Loader2 size={14} aria-hidden className="animate-spin" />
          ) : (
            <RefreshCw size={14} aria-hidden />
          )}
          {t("auto.sessions.refresh")}
        </Button>
      </header>
      {error && (
        <div className="shrink-0 px-4 py-3 text-sm text-status-err">
          <p role="alert">{t("activitySessions.transcriptError", { error })}</p>
          <Button type="button" size="sm" variant="outline" className="mt-2" onClick={refresh}>
            {t("auto.sessions.retry")}
          </Button>
        </div>
      )}
      {hasMore && (
        <div className="shrink-0 px-4 py-2 text-center">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loading || bytes >= MAX_BYTES}
            onClick={() => {
              if (inFlight.current) return;
              inFlight.current = true;
              setBytes((value) => Math.min(value * 2, MAX_BYTES));
            }}
          >
            {t(bytes >= MAX_BYTES ? "activitySessions.historyLimit" : "activitySessions.older")}
          </Button>
        </div>
      )}
      {!state ? (
        <p role="status" className="px-4 py-8 text-sm text-muted-foreground">
          {t(loading ? "auto.sessions.loading" : "activitySessions.unavailable")}
        </p>
      ) : state.messages.length === 0 ? (
        <p role="status" className="px-4 py-8 text-sm text-muted-foreground">
          {t("activitySessions.emptyTranscript")}
        </p>
      ) : (
        <div className="min-h-48 min-w-0 flex-1" aria-busy={loading}>
          <MessageStream messages={state.messages} engineSessionId={sessionId} readOnly />
        </div>
      )}
    </section>
  );
}
