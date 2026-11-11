import React from "react";
import { Gauge, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { UsageProviders } from "./UsageProviders";
import { useT } from "../i18n/I18nProvider";
import {
  isCliUsage,
  hasRecordedTokenUsage,
  readUsageOverview,
  type UsageOverview,
  type UsageRange,
} from "./usageOverview";

export function UsagePage() {
  const { t, lang } = useT();
  const [range, setRange] = React.useState<UsageRange>("30d");
  const [revision, setRevision] = React.useState(0);
  const [overview, setOverview] = React.useState<UsageOverview>();
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(false);
  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    setOverview(undefined);
    void readUsageOverview(
      (query) => window.codeshell.getUsageSummary(query),
      range,
      () => cancelled,
    )
      .then(
        (result) => {
          if (!cancelled) setOverview(result);
        },
        () => {
          if (!cancelled) setError(true);
        },
      )
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [range, revision]);

  const format = (value: number) =>
    new Intl.NumberFormat(lang === "zh" ? "zh-CN" : "en-US").format(value);
  const apiRequests =
    overview?.models
      .filter((row) => !isCliUsage(row))
      .reduce((sum, row) => sum + row.requests - (row.notSentRequests ?? 0), 0) ?? 0;
  const cliTurns =
    overview?.models.filter(isCliUsage).reduce((sum, row) => sum + row.requests, 0) ?? 0;
  const totals = overview?.totals;
  const knownTokens = !!totals && hasRecordedTokenUsage(totals);
  const metrics: Array<readonly [string, number | null]> = totals
    ? [
        [t("usagePage.total"), knownTokens ? totals.totalTokens : null],
        [t("usagePage.input"), knownTokens ? totals.promptTokens : null],
        [t("usagePage.output"), knownTokens ? totals.completionTokens : null],
        [t("usagePage.cached"), knownTokens ? totals.cacheReadTokens : null],
        [t("usagePage.requests"), apiRequests],
        [t("usagePage.turns"), cliTurns],
      ]
    : [];

  return (
    <main className="min-h-0 min-w-0 flex-1 overflow-y-auto" aria-label={t("usagePage.title")}>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-7 px-4 py-6 sm:px-8 sm:py-8">
        <header>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <Gauge size={22} aria-hidden />
            {t("usagePage.title")}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">{t("usagePage.description")}</p>
        </header>

        <UsageProviders />

        <section aria-labelledby="recorded-usage-heading" className="min-w-0">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 id="recorded-usage-heading" className="font-medium">
                {t("usagePage.historyTitle")}
              </h2>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {t("usagePage.historyDescription")}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <select
                aria-label={t("usagePage.range")}
                value={range}
                onChange={(event) => setRange(event.target.value as UsageRange)}
                className="h-8 rounded-lg border border-border bg-background px-2 text-xs"
              >
                <option value="7d">{t("usagePage.week")}</option>
                <option value="30d">{t("usagePage.month")}</option>
                <option value="all">{t("usagePage.all")}</option>
              </select>
              <Button
                variant="outline"
                size="sm"
                disabled={loading}
                onClick={() => setRevision((value) => value + 1)}
              >
                <RefreshCw size={14} aria-hidden />
                {t("usagePage.refresh")}
              </Button>
            </div>
          </div>
          {loading && (
            <p
              role="status"
              className="rounded-xl border border-border p-6 text-sm text-muted-foreground"
            >
              {t("usagePage.loading")}
            </p>
          )}
          {error && (
            <p
              role="alert"
              className="rounded-xl border border-status-err/30 p-5 text-sm text-status-err"
            >
              {t("usagePage.loadFailed")}
            </p>
          )}
          {overview && (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                {metrics.map(([label, value]) => (
                  <div
                    key={label}
                    className="min-w-0 rounded-xl border border-border bg-card px-4 py-4"
                  >
                    <p className="text-xs text-muted-foreground">{label}</p>
                    <p className="mt-2 break-all text-2xl font-semibold tabular-nums tracking-tight">
                      {value === null ? "—" : format(value)}
                    </p>
                  </div>
                ))}
              </div>
              {totals && totals.cacheCreationTokens > 0 && (
                <p className="mt-3 text-xs text-muted-foreground">
                  {t("usagePage.cacheWrite")}: {format(totals.cacheCreationTokens)}
                </p>
              )}
              {overview.partial && (
                <p className="mt-3 text-xs text-status-warn">{t("usagePage.partial")}</p>
              )}
              {totals && totals.unknownUsageRequests > 0 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t("usagePage.unknownUsage", { count: format(totals.unknownUsageRequests) })}
                </p>
              )}
              {!!totals?.notSentRequests && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t("usagePage.notSent", { count: format(totals.notSentRequests) })}
                </p>
              )}
              <h3 className="mb-3 mt-6 text-sm font-medium">{t("usagePage.models")}</h3>
              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full text-left text-xs">
                  <thead className="bg-muted/40 text-muted-foreground">
                    <tr>
                      {[
                        t("usagePage.model"),
                        t("usagePage.provider"),
                        t("usagePage.records"),
                        t("usagePage.input"),
                        t("usagePage.output"),
                        t("usagePage.cached"),
                      ].map((label) => (
                        <th
                          key={label}
                          scope="col"
                          className="whitespace-nowrap px-4 py-3 font-medium"
                        >
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {overview.models.map((row) => (
                      <tr
                        key={JSON.stringify([row.provider, row.model, row.providerKind])}
                        className="border-t border-border"
                      >
                        <td className="max-w-64 break-words px-4 py-3 font-medium">
                          {isCliUsage(row) && row.model === "cli-turn-aggregate"
                            ? t("usagePage.cliAggregate")
                            : row.model}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{row.provider}</td>
                        <td className="whitespace-nowrap px-4 py-3 tabular-nums">
                          {format(
                            row.requests - (isCliUsage(row) ? 0 : (row.notSentRequests ?? 0)),
                          )}{" "}
                          <span className="text-muted-foreground">
                            {t(isCliUsage(row) ? "usagePage.cli" : "usagePage.api")}
                          </span>
                        </td>
                        {[row.promptTokens, row.completionTokens, row.cacheReadTokens].map(
                          (value, index) => (
                            <td key={index} className="px-4 py-3 tabular-nums">
                              {hasRecordedTokenUsage(row) ? format(value) : "—"}
                            </td>
                          ),
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!overview.models.length && (
                  <p className="p-6 text-sm text-muted-foreground">{t("usagePage.noRecords")}</p>
                )}
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                {t("usagePage.updated", {
                  time: new Date(overview.capturedAt).toLocaleString(
                    lang === "zh" ? "zh-CN" : "en-US",
                  ),
                })}
              </p>
            </>
          )}
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            {t("usagePage.historyCoverage")}
          </p>
        </section>
      </div>
    </main>
  );
}
