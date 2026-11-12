import React from "react";
import { useT } from "../i18n/I18nProvider";
import { UsageCachePlot } from "./UsageCachePlot";
import { buildCacheSeries, cacheVolume, type CacheSeries } from "./usageCacheSeries";
import { cacheFormatters, formatRate, seriesColour } from "./usageCacheFormat";
import type { UsageTimeline } from "./usageTimeline";

/** Hit rate per model over time, above the input volume that gives each rate its weight. */
export function UsageCacheChart({ timeline }: { timeline: UsageTimeline }) {
  const { t, lang } = useT();
  const [mainOnly, setMainOnly] = React.useState(true);
  const [hidden, setHidden] = React.useState<ReadonlySet<string>>(() => new Set());
  const [tableOpen, setTableOpen] = React.useState(false);
  const data = React.useMemo(() => buildCacheSeries(timeline, { mainOnly }), [timeline, mainOnly]);
  const visible = data.series.filter((entry) => !hidden.has(entry.key));
  const volume = React.useMemo(() => cacheVolume(data, hidden), [data, hidden]);
  const format = React.useMemo(() => cacheFormatters(lang), [lang]);

  const repeated = new Set<string>();
  const names = new Set<string>();
  for (const entry of data.series) (names.has(entry.model) ? repeated : names).add(entry.model);
  const label = (entry: CacheSeries) => {
    if (entry.other) return t("usagePage.cacheChartOther");
    if (entry.providerKind === "external-cli" && entry.model === "cli-turn-aggregate")
      return `${entry.provider} · ${t("usagePage.cliAggregate")}`;
    return repeated.has(entry.model) ? `${entry.model} · ${entry.provider}` : entry.model;
  };
  const toggle = (key: string) =>
    setHidden((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const tableRows = tableOpen
    ? data.buckets.flatMap((start, index) =>
        visible.some((entry) => entry.points[index]!.requests > 0) ? [{ start, index }] : [],
      )
    : [];
  const mainOnlyId = React.useId();

  return (
    <div className="mt-6 min-w-0">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">{t("usagePage.cacheChartTitle")}</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t("usagePage.cacheChartDescription")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 whitespace-nowrap text-xs">
          <button
            type="button"
            role="switch"
            aria-checked={mainOnly}
            aria-labelledby={mainOnlyId}
            data-state={mainOnly ? "checked" : "unchecked"}
            onClick={() => setMainOnly((value) => !value)}
            className="cs-switch inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <span className="cs-switch-thumb pointer-events-none block h-4 w-4 rounded-full shadow-sm transition-transform" />
          </button>
          <span id={mainOnlyId}>{t("usagePage.cacheChartMainOnly")}</span>
        </div>
      </div>

      {!data.series.length ? (
        <p className="rounded-xl border border-border p-6 text-sm text-muted-foreground">
          {t("usagePage.cacheChartEmpty")}
        </p>
      ) : (
        <div className="min-w-0 rounded-xl border border-border bg-card p-3 sm:p-4">
          <ul
            aria-label={t("usagePage.cacheChartLegend")}
            className="mb-2 flex flex-wrap gap-x-1 gap-y-1"
          >
            {data.series.map((entry) => {
              const shown = !hidden.has(entry.key);
              return (
                <li key={entry.key} className="min-w-0">
                  <button
                    type="button"
                    data-series-toggle={entry.key}
                    aria-pressed={shown}
                    onClick={() => toggle(entry.key)}
                    className={`flex max-w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                      shown ? "" : "text-muted-foreground line-through"
                    }`}
                  >
                    <span
                      aria-hidden
                      className="h-0.5 w-4 shrink-0 rounded-full"
                      style={{ background: seriesColour(entry), opacity: shown ? 1 : 0.35 }}
                    />
                    <span className="min-w-0 break-all">{label(entry)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {visible.length ? (
            <UsageCachePlot data={data} visible={visible} volume={volume} label={label} />
          ) : (
            <p className="px-2 py-10 text-center text-sm text-muted-foreground">
              {t("usagePage.cacheChartAllHidden")}
            </p>
          )}
          <ul className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 px-2 text-xs text-muted-foreground">
            <li>{t("usagePage.cacheChartVolume")}</li>
            <li className="flex items-center gap-1.5">
              <span aria-hidden className="h-2.5 w-2.5 rounded-[2px] bg-foreground/75" />
              {t("usagePage.cacheChartCached")}
            </li>
            <li className="flex items-center gap-1.5">
              <span aria-hidden className="h-2.5 w-2.5 rounded-[2px] bg-muted-foreground/60" />
              {t("usagePage.cacheChartUncached")}
            </li>
          </ul>
          <details
            className="mt-3 px-2 text-xs"
            onToggle={(event) => setTableOpen(event.currentTarget.open)}
          >
            <summary className="cursor-pointer text-muted-foreground">
              {t("usagePage.cacheChartTable")}
            </summary>
            {tableOpen && (
              <div className="mt-2 max-h-72 overflow-auto rounded-lg border border-border">
                <table className="w-full text-left tabular-nums">
                  <thead className="bg-muted/40 text-muted-foreground">
                    <tr>
                      <th scope="col" className="whitespace-nowrap px-3 py-2 font-medium">
                        {t("usagePage.cacheChartPeriod")}
                      </th>
                      {visible.map((entry) => (
                        <th key={entry.key} scope="col" className="px-3 py-2 font-medium">
                          {label(entry)} · {t("usagePage.cacheChartHitRate")}
                        </th>
                      ))}
                      <th scope="col" className="whitespace-nowrap px-3 py-2 font-medium">
                        {t("usagePage.cacheChartCached")}
                      </th>
                      <th scope="col" className="whitespace-nowrap px-3 py-2 font-medium">
                        {t("usagePage.cacheChartUncached")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {tableRows.map(({ start, index }) => (
                      <tr key={start} className="border-t border-border">
                        <th scope="row" className="whitespace-nowrap px-3 py-2 font-normal">
                          {format.period(start, data.bucketEnds[index]!, data.bucketMs)}
                        </th>
                        {visible.map((entry) => {
                          const value = entry.points[index]!;
                          return (
                            <td key={entry.key} className="px-3 py-2">
                              {value.rate !== null
                                ? formatRate(value.rate)
                                : value.requests > 0
                                  ? t("usagePage.cacheChartLowVolume")
                                  : "—"}
                            </td>
                          );
                        })}
                        <td className="px-3 py-2">{format.full(volume[index]!.cached)}</td>
                        <td className="px-3 py-2">{format.full(volume[index]!.uncached)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </details>
        </div>
      )}
    </div>
  );
}
