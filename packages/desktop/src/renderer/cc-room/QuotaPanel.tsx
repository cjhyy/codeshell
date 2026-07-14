/**
 * QuotaPanel — a room-header chip that reveals remaining CC/Codex subscription
 * quota (the 5h/7d windows their status lines show) with reset countdowns.
 *
 * Thin client: talks only to `window.codeshell.quota.get()`. Fetches on open
 * (lazy — no cost until the user asks). Codex is free; Claude costs ~1 token,
 * so the panel notes that and lets you refresh explicitly.
 */
import React from "react";
import type { ProviderQuota, QuotaResult } from "@cjhyy/code-shell-capability-coding";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Which = "claude" | "codex" | "both";

export function QuotaPanel({ which = "both" }: { which?: Which }) {
  const [open, setOpen] = React.useState(false);
  const [data, setData] = React.useState<QuotaResult | null>(null);
  const [loading, setLoading] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);

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

  // Close on outside click.
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Compact chip summary: the highest used-% across shown providers/windows.
  const peak = data ? peakPercent(data) : null;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs",
          "hover:bg-accent",
          peak != null && peak >= 90
            ? "border-status-err/50 text-status-err"
            : peak != null && peak >= 75
              ? "border-status-warn/50 text-status-warn"
              : "text-muted-foreground",
        )}
        title="查看 CC/Codex 剩余额度"
      >
        <span>额度</span>
        {peak != null && <span className="font-mono">{peak.toFixed(0)}%</span>}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-1 w-[280px] rounded-md border bg-popover p-3 text-sm text-popover-foreground shadow-lg">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              剩余额度
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
              {data.claude && <ProviderBlock name="Claude Code" pq={data.claude} />}
              {data.codex && <ProviderBlock name="Codex" pq={data.codex} />}
            </div>
          )}

          <p className="mt-2 border-t border-border pt-2 text-[10px] leading-tight text-muted-foreground">
            Codex 免费查询；Claude 会发 1-token 探测。
          </p>
        </div>
      )}
    </div>
  );
}

function ProviderBlock({ name, pq }: { name: string; pq: ProviderQuota }) {
  if (pq.error || !pq.windows) {
    return (
      <div>
        <div className="mb-0.5 font-medium">{name}</div>
        <div className="text-xs text-status-err">查询失败：{pq.error ?? "unknown"}</div>
      </div>
    );
  }
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        <span className="font-medium">{name}</span>
        {pq.planType && (
          <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
            {pq.planType}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        {pq.windows.map((w) => (
          <QuotaBar key={w.kind} label={w.kind} usedPercent={w.usedPercent} resetsAt={w.resetsAt} />
        ))}
      </div>
    </div>
  );
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
  const pct = Math.max(0, Math.min(100, usedPercent));
  const barColor = pct >= 90 ? "bg-status-err" : pct >= 75 ? "bg-status-warn" : "bg-status-running";
  return (
    <div>
      <div className="mb-0.5 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono">{pct.toFixed(0)}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full", barColor)} style={{ width: `${pct}%` }} />
      </div>
      {resetsAt != null && (
        <div className="mt-0.5 text-right text-[10px] text-muted-foreground">
          重置 {formatReset(resetsAt)}
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
      peak = peak == null ? w.usedPercent : Math.max(peak, w.usedPercent);
    }
  }
  return peak;
}

/** Absolute epoch-seconds → "2h13m 后" / "已重置". Recomputed on each render. */
function formatReset(resetsAt: number): string {
  const delta = resetsAt - Math.floor(Date.now() / 1000);
  if (delta <= 0) return "已重置";
  const h = Math.floor(delta / 3600);
  const m = Math.floor((delta % 3600) / 60);
  return h > 0 ? `${h}h${m}m 后` : `${m}m 后`;
}
