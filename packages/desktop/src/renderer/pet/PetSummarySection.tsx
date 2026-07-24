import React from "react";
import { Loader2, Sparkles, X } from "lucide-react";
import type { PetSessionSummaryRow } from "../../preload/types";
import { useT } from "../i18n";

/**
 * "Mimi 小结" workbench block: one natural-language closure paragraph per
 * completed work session (conclusion + any follow-up the assistant asked),
 * newest first. Self-fetching: pulls `window.codeshell.pet.getSummaries()` on
 * mount and whenever the snapshot version advances (debounced), with a sequence
 * guard so a slow response can never overwrite a newer one.
 *
 * Dismiss reuses the shared work-inbox: the row id is `completed:${sessionId}`,
 * which the completed work-tree bucket also uses — dismissing a recap clears the
 * same finished session from both surfaces (a single "done with it" gesture).
 */
const FETCH_DEBOUNCE_MS = 2_000;

/** Stable work-inbox dismiss id for a summary row (shared with the work tree). */
export function summaryDismissId(sessionId: string): string {
  return `completed:${sessionId}`;
}

export function PetSummarySection({
  snapshotVersion,
  generation,
  onOpen,
  onDismiss,
  dismissedIds,
}: {
  snapshotVersion: number;
  generation: number;
  onOpen?: (sessionId: string) => void;
  onDismiss?: (id: string) => void;
  dismissedIds?: ReadonlySet<string>;
}) {
  // `generation` is accepted so callers can pass the same snapshot identity the
  // sibling sections use; the pull is keyed by version, which advances with it.
  void generation;
  const [rows, setRows] = React.useState<PetSessionSummaryRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const seqRef = React.useRef(0);
  const loadedOnceRef = React.useRef(false);

  React.useEffect(() => {
    let disposed = false;
    const run = (): void => {
      const seq = (seqRef.current += 1);
      const getSummaries = window.codeshell.pet?.getSummaries;
      if (!getSummaries) {
        if (!disposed) setLoading(false);
        return;
      }
      void Promise.resolve(getSummaries())
        .then((next) => {
          if (disposed || seq !== seqRef.current) return;
          loadedOnceRef.current = true;
          setRows(next);
          setLoading(false);
        })
        .catch(() => {
          if (disposed || seq !== seqRef.current) return;
          loadedOnceRef.current = true;
          setLoading(false);
        });
    };
    const timer = setTimeout(run, loadedOnceRef.current ? FETCH_DEBOUNCE_MS : 0);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [snapshotVersion]);

  return (
    <PetSummarySectionView
      rows={rows}
      loading={loading && !loadedOnceRef.current}
      onOpen={onOpen}
      onDismiss={onDismiss}
      dismissedIds={dismissedIds}
    />
  );
}

export default function PetSummarySectionView({
  rows,
  loading,
  onOpen,
  onDismiss,
  dismissedIds,
}: {
  rows: readonly PetSessionSummaryRow[];
  loading: boolean;
  onOpen?: (sessionId: string) => void;
  onDismiss?: (id: string) => void;
  dismissedIds?: ReadonlySet<string>;
}) {
  const { t } = useT();
  const visible = rows.filter((row) => !dismissedIds?.has(summaryDismissId(row.sessionId)));
  return (
    <section
      data-pet-summaries="closure"
      className="rounded-2xl border border-border/60 bg-background/45 p-1"
    >
      <div className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2.5 text-left">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Sparkles size={16} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">{t("pet.summary.title")}</span>
        </span>
        <span className="rounded-full bg-primary/10 px-2.5 py-1 text-[10px] font-semibold text-primary">
          {visible.length}
        </span>
      </div>
      <div className="space-y-2 px-1.5 pb-1.5 pt-1">
        {loading ? (
          <p className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
            <Loader2
              size={12}
              className="animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            {t("pet.summary.loading")}
          </p>
        ) : visible.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">{t("pet.summary.empty")}</p>
        ) : (
          visible.map((row) => (
            <article
              key={row.sessionId}
              data-pet-summary-row={row.sessionId}
              className="rounded-2xl border border-border/60 bg-background/60 p-3"
            >
              <div className="flex w-full min-w-0 items-baseline gap-2">
                {onOpen ? (
                  <button
                    type="button"
                    data-pet-summary-open={row.sessionId}
                    aria-label={t("pet.summary.openSessionAria", { title: row.title })}
                    className="flex min-w-0 flex-1 items-baseline gap-2 text-left transition hover:text-primary"
                    onClick={() => onOpen(row.sessionId)}
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                      {row.title}
                    </span>
                    {row.workspace && (
                      <span className="shrink-0 truncate text-[11px] text-muted-foreground">
                        {row.workspace}
                      </span>
                    )}
                  </button>
                ) : (
                  <div className="flex min-w-0 flex-1 items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                      {row.title}
                    </span>
                    {row.workspace && (
                      <span className="shrink-0 truncate text-[11px] text-muted-foreground">
                        {row.workspace}
                      </span>
                    )}
                  </div>
                )}
                {onDismiss && (
                  <button
                    type="button"
                    data-pet-summary-dismiss={row.sessionId}
                    aria-label={t("pet.summary.dismissAria", { title: row.title })}
                    className="shrink-0 rounded-md p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                    onClick={() => onDismiss(summaryDismissId(row.sessionId))}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                )}
              </div>
              <p className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap text-sm text-muted-foreground">
                {row.text}
              </p>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
