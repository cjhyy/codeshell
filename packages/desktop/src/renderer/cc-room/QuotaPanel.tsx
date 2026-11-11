/**
 * QuotaPanel — a room-header chip that reveals CC/Codex subscription usage
 * (the 5h/7d windows their status lines show) with local reset times.
 *
 * Thin client: talks only to `window.codeshell.quota.get()`. Fetches on open
 * (lazy — no cost until the user asks). Codex is free; Claude costs ~1 token,
 * so the panel notes that and lets you refresh explicitly.
 */
import React from "react";
import type { ProviderQuota, QuotaResult } from "@cjhyy/code-shell-capability-coding/orchestration";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useT, type TFunction } from "../i18n/I18nProvider";

type Which = "claude" | "codex" | "both";

export function QuotaPanel({ which = "both" }: { which?: Which }) {
  // Each provider selection owns its cache and pending request.
  return <QuotaPanelContent key={which} which={which} />;
}

function QuotaPanelContent({ which }: { which: Which }) {
  const [open, setOpen] = React.useState(false);
  const [data, setData] = React.useState<QuotaResult | null>(null);
  const [loading, setLoading] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await window.codeshell.quota.get(which);
      setData(r);
    } catch {
      setData({});
    } finally {
      setLoading(false);
    }
  }, [which]);

  // Fetch the first time the panel opens; keep the last result cached after.
  React.useEffect(() => {
    if (open && !data && !loading) void load();
  }, [open, data, loading, load]);

  // Compact chip summary: the highest used-% across shown providers/windows.
  const peak = data ? peakPercent(data) : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs",
            "hover:bg-accent",
            peak != null && peak >= 90
              ? "border-status-err/50 text-status-err"
              : peak != null && peak >= 75
                ? "border-status-warn/50 text-status-warn"
                : "text-muted-foreground",
          )}
          title="查看使用限额；百分比为各项限额中最高的已使用比例"
        >
          <span>用量</span>
          {peak != null && <span className="tabular-nums">已使用 {peak.toFixed(0)}%</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" aria-label="使用限额" className="w-[280px] p-3 text-sm">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            使用限额
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            disabled={loading}
            onClick={() => {
              setData(null);
              void load();
            }}
          >
            {loading ? "查询中…" : "刷新"}
          </Button>
        </div>

        {!data && loading && <p className="text-xs text-muted-foreground">查询中…</p>}
        {data && (
          <div className="flex flex-col gap-3">
            {data.claude && <QuotaProviderBlock name="Claude Code" pq={data.claude} />}
            {data.codex && <QuotaProviderBlock name="Codex" pq={data.codex} />}
          </div>
        )}

        <p className="mt-2 border-t border-border pt-2 text-[10px] leading-tight text-muted-foreground">
          {which === "codex"
            ? "Codex 免费查询。"
            : which === "claude"
              ? "Claude 会发 1-token 探测。"
              : "Codex 免费查询；Claude 会发 1-token 探测。"}
        </p>
      </PopoverContent>
    </Popover>
  );
}

export function QuotaProviderBlock({
  name,
  pq,
  hideName = false,
}: {
  name: string;
  pq: ProviderQuota;
  hideName?: boolean;
}) {
  const { t } = useT();
  if (pq.error || !pq.windows?.length) {
    return (
      <div>
        {!hideName && <div className="mb-0.5 font-medium">{name}</div>}
        <div className={cn("text-xs", pq.error ? "text-status-err" : "text-muted-foreground")}>
          {pq.error
            ? t("usagePage.quotaQueryFailed", { error: pq.error })
            : t("usagePage.quotaUnavailable")}
        </div>
      </div>
    );
  }
  const weekly = pq.windows.filter(
    (w) => pq.provider === "claude" && (w.kind === "7d" || /^7d[_-]/.test(w.kind)),
  );
  const other = pq.windows.filter((w) => !weekly.includes(w));
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        {!hideName && <span className="font-medium">{name}</span>}
        {pq.planType && (
          <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
            {pq.planType}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        {other.map((w) => (
          <QuotaBar
            key={w.kind}
            label={windowLabel(w.kind, t)}
            usedPercent={w.usedPercent}
            resetsAt={w.resetsAt}
          />
        ))}
        {weekly.length > 0 && (
          <section className="mt-2 flex flex-col gap-2">
            <h3 className="text-xs font-medium">{t("usagePage.quotaWeekly")}</h3>
            {weekly.map((w) => (
              <QuotaBar
                key={w.kind}
                label={weeklyLabel(w.kind, t)}
                usedPercent={w.usedPercent}
                resetsAt={w.resetsAt}
              />
            ))}
          </section>
        )}
      </div>
      {pq.provider === "claude" && (
        <button
          type="button"
          className="mt-2 text-left text-[10px] text-muted-foreground underline hover:text-foreground"
          onClick={() =>
            void window.codeshell.openExternal(
              "https://support.claude.com/en/articles/11647753-understanding-usage-and-length-limits",
            )
          }
        >
          {t("usagePage.quotaLearnMore")}
        </button>
      )}
    </div>
  );
}

function windowLabel(kind: string, t: TFunction): string {
  switch (kind) {
    case "5h":
      return t("usagePage.quotaCurrentWindow");
    case "7d":
      return t("usagePage.quotaWeekly");
    case "overage":
      return t("usagePage.quotaOverage");
    default:
      return kind;
  }
}

function weeklyLabel(kind: string, t: TFunction): string {
  if (kind === "7d") return t("usagePage.quotaAllModels");
  const model = kind.replace(/^7d[_-]/, "");
  switch (model) {
    case "fable":
      return "Fable";
    case "sonnet":
      return "Sonnet";
    case "opus":
      return "Opus";
    case "haiku":
      return "Haiku";
    default:
      return kind;
  }
}

function QuotaBar({
  label,
  usedPercent,
  resetsAt,
}: {
  label: string;
  usedPercent: number;
  resetsAt: number | null;
}) {
  const { t, lang } = useT();
  if (!Number.isFinite(usedPercent))
    return <p className="text-xs text-muted-foreground">{t("usagePage.quotaUnavailable")}</p>;
  const pct = Math.max(0, Math.min(100, usedPercent));
  const barColor = pct >= 90 ? "bg-status-err" : pct >= 75 ? "bg-status-warn" : "bg-status-running";
  return (
    <div>
      <div className="mb-0.5 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums">
          {t("usagePage.quotaUsed", { percent: pct.toFixed(0) })}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={t("usagePage.quotaUsedLabel", { label })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div className={cn("h-full rounded-full", barColor)} style={{ width: `${pct}%` }} />
      </div>
      {resetsAt != null && (
        <div className="mt-0.5 text-right text-[10px] text-muted-foreground">
          {formatReset(resetsAt, lang === "zh" ? "zh-CN" : "en-US", t)}
        </div>
      )}
    </div>
  );
}

/** Highest used-% across all shown windows — the chip's at-a-glance number. */
function peakPercent(r: QuotaResult): number | null {
  let peak: number | null = null;
  for (const pq of [r.claude, r.codex]) {
    for (const w of pq?.windows ?? []) {
      const pct = Math.max(0, Math.min(100, w.usedPercent));
      peak = peak == null ? pct : Math.max(peak, pct);
    }
  }
  return peak;
}

/** Show the provider's actual reset in the user's local timezone. */
function formatReset(resetsAt: number, locale: string, t: TFunction): string {
  const delta = resetsAt - Math.floor(Date.now() / 1000);
  if (delta <= 0) return t("usagePage.quotaResetDue");
  const date = new Date(resetsAt * 1000);
  const day = date.toLocaleDateString(locale, {
    ...(delta >= 7 * 86400 ? { year: "numeric", month: "numeric", day: "numeric" } : {}),
    weekday: "short",
  });
  const time = date.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return t("usagePage.quotaReset", { time: `${day} ${time}` });
}
