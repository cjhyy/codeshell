import React, { useEffect, useRef, useState } from "react";
import { FileText, Loader2, RefreshCw, Search, WrapText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { useT } from "../i18n/I18nProvider";
import type { TranslationKey } from "../i18n/dict";

type Bucket = "ui-ink" | "engine" | "desktop";
const BUCKETS: Array<{ value: Bucket; label: TranslationKey }> = [
  { value: "desktop", label: "auto.logs.desktop" },
  { value: "engine", label: "auto.logs.engine" },
  { value: "ui-ink", label: "auto.logs.terminal" },
];
interface ReadState {
  bucket: Bucket;
  lines: string[] | null;
  loading: boolean;
  error: string | null;
}

export function LogsView() {
  const { t } = useT();
  const [bucket, setBucket] = useState<Bucket>("desktop");
  const [read, setRead] = useState<ReadState>({
    bucket: "desktop",
    lines: null,
    loading: true,
    error: null,
  });
  const [revision, setRevision] = useState(0);
  const [filter, setFilter] = useState("");
  const [wrapLines, setWrapLines] = useState(true);
  const searchRef = useRef<HTMLInputElement>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const loadingRef = useRef(true);

  useEffect(() => {
    let cancelled = false;
    loadingRef.current = true;
    setRead((current) => ({
      bucket,
      lines: current.bucket === bucket ? current.lines : null,
      loading: true,
      error: null,
    }));
    void (async () => {
      try {
        const lines = await window.codeshell.tailLog(bucket, 500);
        if (!cancelled) setRead({ bucket, lines, loading: false, error: null });
      } catch (error) {
        if (!cancelled)
          setRead((current) => ({
            ...current,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          }));
      } finally {
        if (!cancelled) loadingRef.current = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bucket, revision]);

  // Do not label the previous bucket's data as the newly selected log before its effect runs.
  const current: ReadState =
    read.bucket === bucket ? read : { bucket, lines: null, loading: true, error: null };
  const query = filter.toLowerCase();
  const filtered = current.lines?.filter((line) => !query || line.toLowerCase().includes(query));
  const refresh = () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    refreshRef.current?.focus({ preventScroll: true });
    setRevision((value) => value + 1);
  };
  const clearFilter = () => {
    setFilter("");
    searchRef.current?.focus({ preventScroll: true });
  };

  return (
    <Tabs
      value={bucket}
      onValueChange={(value) => setBucket(value as Bucket)}
      className="flex h-full min-h-0 min-w-0 flex-col bg-muted/10"
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-4 pt-6 sm:px-6">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl border border-border/70 bg-card text-primary">
            <FileText size={20} aria-hidden />
          </span>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">{t("auto.logs.title")}</h1>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {t("auto.logs.description")}
            </p>
          </div>
        </div>
        <Button
          ref={refreshRef}
          type="button"
          size="sm"
          variant="outline"
          className="h-9 rounded-xl aria-disabled:cursor-wait aria-disabled:opacity-60"
          aria-disabled={current.loading}
          onClick={refresh}
        >
          {current.loading ? (
            <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden />
          ) : (
            <RefreshCw size={14} aria-hidden />
          )}
          {t("auto.logs.refresh")}
        </Button>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 px-4 py-5 sm:px-6">
        <div className="flex shrink-0 flex-wrap items-center gap-3 rounded-2xl border border-border/70 bg-card p-2.5">
          <TabsList
            aria-label={t("auto.logs.sources")}
            className="grid h-9 min-w-0 grid-cols-3 rounded-xl"
          >
            {BUCKETS.map(({ value, label }) => (
              <TabsTrigger
                key={value}
                value={value}
                title={value}
                className="min-w-0 rounded-lg px-2.5 text-xs"
              >
                {t(label)}
              </TabsTrigger>
            ))}
          </TabsList>
          <div role="search" className="relative min-w-0 flex-1 basis-52">
            <Search
              size={15}
              aria-hidden
              className="pointer-events-none absolute left-3 top-2.5 text-muted-foreground"
            />
            <Input
              ref={searchRef}
              type="search"
              className="h-9 rounded-xl border-transparent bg-muted/40 pl-9 pr-9 [&::-webkit-search-cancel-button]:appearance-none"
              placeholder={t("auto.logs.grepPlaceholder")}
              aria-label={t("auto.logs.grepPlaceholder")}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            {filter && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="absolute right-0.5 top-0.5 size-8 rounded-lg"
                aria-label={t("auto.logs.clearSearch")}
                onClick={clearFilter}
              >
                <X size={14} aria-hidden />
              </Button>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-1">
          <p role="status" className="text-xs tabular-nums text-muted-foreground">
            {current.lines &&
              t("auto.logs.count", { count: filtered?.length ?? 0, total: current.lines.length })}
          </p>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 rounded-lg text-xs"
            aria-pressed={wrapLines}
            onClick={() => setWrapLines((value) => !value)}
          >
            <WrapText size={14} aria-hidden />
            {t("auto.logs.wrapLines")}
          </Button>
        </div>
        {current.error && (
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-xl border border-status-err/25 bg-status-err/5 p-3 text-sm">
            <p
              role="alert"
              className="min-w-0 flex-1 break-words text-status-err [overflow-wrap:anywhere]"
            >
              {t("auto.logs.readError", { error: current.error })}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="rounded-lg"
              onClick={refresh}
            >
              {t("auto.logs.retry")}
            </Button>
          </div>
        )}
        <TabsContent
          key={bucket}
          value={bucket}
          aria-busy={current.loading}
          className="mt-0 min-h-0 min-w-0 flex-1 overflow-auto rounded-2xl border border-border/70 bg-card/70 focus-visible:ring-inset"
        >
          {current.lines === null ? (
            <div
              role="status"
              className="flex flex-col items-center gap-3 px-5 py-10 text-center text-sm text-muted-foreground"
            >
              {current.loading && (
                <Loader2
                  size={20}
                  className="animate-spin motion-reduce:animate-none"
                  aria-hidden
                />
              )}
              {t(current.loading ? "auto.logs.loading" : "auto.logs.unavailable")}
            </div>
          ) : filtered?.length === 0 ? (
            <div role="status" className="flex flex-col items-center gap-3 px-5 py-10 text-center">
              <FileText size={24} aria-hidden className="text-muted-foreground" />
              <h2 className="text-sm font-medium">
                {t(current.lines.length === 0 ? "auto.logs.noLines" : "auto.logs.noMatch")}
              </h2>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {t(current.lines.length === 0 ? "auto.logs.emptyHint" : "auto.logs.noMatchHint")}
              </p>
              {current.lines.length > 0 && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="rounded-lg"
                  onClick={clearFilter}
                >
                  {t("auto.logs.clearSearch")}
                </Button>
              )}
            </div>
          ) : (
            <pre
              className={cn(
                "m-0 min-w-0 p-4 font-mono text-xs leading-relaxed",
                wrapLines
                  ? "whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
                  : "whitespace-pre",
              )}
            >
              {filtered?.join("\n")}
            </pre>
          )}
        </TabsContent>
      </div>
    </Tabs>
  );
}
