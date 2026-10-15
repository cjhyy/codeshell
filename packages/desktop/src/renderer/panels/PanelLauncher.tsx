import React, { useEffect, useId, useRef, useState } from "react";
import { AppWindow, LoaderCircle, RefreshCw, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "../i18n/I18nProvider";
import { panelEntryTitle, type PanelEntry } from "./PanelRegistry";
import { usePanelCatalogState } from "./PanelCatalogContext";

interface Props {
  entries: readonly PanelEntry[];
  onPick: (kind: string) => void;
  onOpenWindow?: (kind: string) => void;
  openingWindowKinds?: ReadonlySet<string>;
  active?: boolean;
  /** Increment only for an explicit + action, never for ordinary tab switching. */
  focusRequest?: number;
}

/** Local catalog selection; opening a launcher never mounts the listed panels. */
export function PanelLauncher({
  entries,
  onPick,
  onOpenWindow,
  openingWindowKinds,
  active = true,
  focusRequest = 0,
}: Props) {
  const { t } = useT();
  const catalog = usePanelCatalogState();
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const previousActivation = useRef({ active: false, focusRequest: 0 });
  useEffect(() => {
    const previous = previousActivation.current;
    previousActivation.current = { active, focusRequest };
    if (active && (!previous.active || focusRequest > previous.focusRequest))
      catalogRef.current.refresh();
  }, [active, focusRequest]);
  const id = useId();
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const consumedFocusRequest = useRef(0);
  useEffect(() => {
    if (active && focusRequest > consumedFocusRequest.current) {
      consumedFocusRequest.current = focusRequest;
      searchRef.current?.focus({ preventScroll: true });
    }
  }, [active, focusRequest]);
  const search = query.trim().toLocaleLowerCase();
  const available = entries
    .filter((entry) => !entry.internalOnly)
    .map((entry) => ({ entry, title: panelEntryTitle(entry, (key) => t(key as never)) }));
  const filtered = available.filter(
    ({ entry, title }) =>
      !search ||
      title.toLocaleLowerCase().includes(search) ||
      entry.key.toLocaleLowerCase().includes(search),
  );
  const tools = filtered.filter(({ entry }) => entry.owner.kind !== "panel-app");
  const panels = filtered.filter(({ entry }) => entry.owner.kind === "panel-app");

  return (
    <section
      data-panel-launcher=""
      aria-label={t("panels.area.launcherTitle")}
      aria-hidden={!active || undefined}
      inert={!active || undefined}
      className="@container/panel-launcher flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-muted/15"
    >
      <div className="mx-auto w-full max-w-3xl space-y-8 px-5 pb-8 pt-7 @min-[600px]/panel-launcher:px-8 @min-[600px]/panel-launcher:pt-10">
        <div className="space-y-2">
          <div role="search" className="relative mx-auto w-full max-w-xl">
            <label htmlFor={`${id}-search`} className="sr-only">
              {t("panels.launcher.searchPlaceholder")}
            </label>
            <Search
              className="pointer-events-none absolute left-3.5 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              ref={searchRef}
              id={`${id}-search`}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("panels.launcher.searchPlaceholder")}
              disabled={!active}
              autoComplete="off"
              spellCheck={false}
              aria-controls={`${id}-results`}
              className="h-11 rounded-xl bg-background pl-10 pr-11 shadow-sm [&::-webkit-search-cancel-button]:appearance-none"
            />
            {query && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("panels.launcher.clearSearch")}
                title={t("panels.launcher.clearSearch")}
                onClick={() => setQuery("")}
                disabled={!active}
                className="absolute right-1.5 top-1/2 size-8 -translate-y-1/2 rounded-lg text-muted-foreground"
              >
                <X aria-hidden="true" />
              </Button>
            )}
          </div>
          <div className="mx-auto flex w-full max-w-xl justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-panel-launcher-refresh=""
              disabled={!active || catalog.loading}
              onClick={catalog.refresh}
              title={t("panels.launcher.refreshPanels")}
              className="h-7 gap-1.5 rounded-lg px-2 text-xs text-muted-foreground"
            >
              {catalog.loading ? (
                <LoaderCircle
                  className="size-3.5 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <RefreshCw className="size-3.5" aria-hidden="true" />
              )}
              {t("panels.launcher.refreshPanels")}
            </Button>
          </div>
        </div>

        <div id={`${id}-results`} className="space-y-8">
          {catalog.loading && (
            <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
              <LoaderCircle
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
              {t("panels.launcher.catalogLoading")}
            </div>
          )}
          {catalog.error && (
            <div
              role="alert"
              className="space-y-2 rounded-xl border border-status-err/25 bg-background p-4"
            >
              <p className="break-words text-xs leading-relaxed text-status-err [overflow-wrap:anywhere]">
                {t("panels.launcher.catalogError", { error: catalog.error })}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!active || catalog.loading}
                onClick={catalog.refresh}
              >
                {t("panels.common.retry")}
              </Button>
            </div>
          )}
          {search && (available.length > 0 || (!catalog.loading && !catalog.error)) && (
            <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
              {t("panels.launcher.resultCount", { count: filtered.length })}
            </div>
          )}
          {available.length === 0 ? (
            catalog.loading || catalog.error ? null : (
              <div role="status" className="rounded-xl border border-dashed border-border/70 p-6">
                <p className="text-sm font-medium text-foreground">{t("panels.launcher.empty")}</p>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  {t("panels.launcher.emptyHint")}
                </p>
              </div>
            )
          ) : filtered.length === 0 ? (
            <div className="py-8 text-center">
              <Search className="mx-auto mb-3 size-5 text-muted-foreground/60" aria-hidden="true" />
              <p className="text-sm font-medium text-foreground">
                {t("panels.launcher.noResults")}
              </p>
              <p className="mt-1.5 text-xs text-muted-foreground">
                {t("panels.launcher.noResultsHint")}
              </p>
              <Button type="button" variant="link" onClick={() => setQuery("")} disabled={!active}>
                {t("panels.launcher.clearSearch")}
              </Button>
            </div>
          ) : (
            <>
              {tools.length > 0 && (
                <section data-panel-launcher-group="tools" aria-labelledby={`${id}-tools`}>
                  <h2 id={`${id}-tools`} className="mb-3 text-sm font-semibold text-foreground">
                    {t("panels.launcher.tools")}
                  </h2>
                  <div className="grid min-w-0 grid-cols-1 gap-2.5 @min-[448px]/panel-launcher:grid-cols-2">
                    {tools.map(({ entry, title }) => {
                      const Icon = entry.icon;
                      return (
                        <Button
                          key={entry.key}
                          type="button"
                          variant="outline"
                          data-panel-launcher-kind={entry.key}
                          data-panel-menu-kind={entry.key}
                          onClick={() => onPick(entry.key)}
                          disabled={!active}
                          title={title}
                          className="h-auto min-h-18 min-w-0 justify-start gap-3 whitespace-normal rounded-xl border-border/65 bg-background px-4 py-3 text-left shadow-sm hover:border-primary/30 hover:bg-primary/5"
                        >
                          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/65 text-muted-foreground">
                            <Icon aria-hidden="true" />
                          </span>
                          <span className="min-w-0 max-w-full flex-1 break-words text-sm leading-5 text-foreground [overflow-wrap:anywhere]">
                            {title}
                          </span>
                        </Button>
                      );
                    })}
                  </div>
                </section>
              )}
              {panels.length > 0 && (
                <section data-panel-launcher-group="panels" aria-labelledby={`${id}-panels`}>
                  <h2 id={`${id}-panels`} className="mb-3 text-sm font-semibold text-foreground">
                    {t("panels.launcher.myPanels")}
                  </h2>
                  <div className="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(min(100%,9rem),1fr))] gap-2.5">
                    {panels.map(({ entry, title }) => {
                      const Icon = entry.icon;
                      const opening = openingWindowKinds?.has(entry.key) === true;
                      return (
                        <div
                          key={entry.key}
                          className="flex min-w-0 flex-col rounded-xl border border-border/65 bg-background shadow-sm"
                        >
                          <Button
                            type="button"
                            variant="ghost"
                            data-panel-launcher-kind={entry.key}
                            data-panel-menu-kind={entry.key}
                            onClick={() => onPick(entry.key)}
                            disabled={!active}
                            title={title}
                            className="h-auto min-h-28 min-w-0 flex-1 flex-col items-start justify-start gap-3 whitespace-normal rounded-xl px-4 py-4 text-left hover:bg-primary/5"
                          >
                            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/8 text-primary">
                              <Icon aria-hidden="true" />
                            </span>
                            <span className="w-full min-w-0 max-w-full break-words text-sm leading-5 text-foreground [overflow-wrap:anywhere]">
                              {title}
                            </span>
                          </Button>
                          {onOpenWindow && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              data-panel-launcher-window-kind={entry.key}
                              aria-label={t("panels.launcher.openWindowFor", { title })}
                              title={t("panels.area.openWindow")}
                              aria-busy={opening || undefined}
                              disabled={!active || opening}
                              onClick={() => {
                                if (active) onOpenWindow(entry.key);
                              }}
                              className="h-auto min-h-9 min-w-0 justify-start gap-2 whitespace-normal rounded-t-none rounded-b-xl border-t border-border/50 px-3 py-2 text-left text-xs leading-4 text-primary"
                            >
                              {opening ? (
                                <LoaderCircle
                                  className="size-3.5 animate-spin motion-reduce:animate-none"
                                  aria-hidden="true"
                                />
                              ) : (
                                <AppWindow className="size-3.5" aria-hidden="true" />
                              )}
                              <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                                {t("panels.area.openWindow")}
                              </span>
                            </Button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
