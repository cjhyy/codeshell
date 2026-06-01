import React, { useEffect, useState } from "react";
import type { RunSummary, RunDetail } from "../../preload/types";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const STATUS_TONES: Record<string, string> = {
  queued: "bg-status-idle",
  running: "bg-status-running",
  waiting_input: "bg-status-warn",
  waiting_approval: "bg-status-warn",
  blocked: "bg-status-warn",
  completed: "bg-status-ok",
  failed: "bg-status-err",
  cancelled: "bg-status-warn",
};

export function RunsView({ initialRunId }: { initialRunId?: string | null } = {}) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(initialRunId ?? null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");

  const refresh = async () => {
    try {
      const list = await window.codeshell.listRuns();
      setRuns(list);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  // Jump-from-automation: when the parent hands us a new run id (e.g. the
  // 自动化 detail's 「查看」 button), select it so its detail renders.
  useEffect(() => {
    if (initialRunId) setSelected(initialRunId);
  }, [initialRunId]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void window.codeshell.getRun(selected).then((d) => {
      if (!cancelled) setDetail(d);
    });
    return () => { cancelled = true; };
  }, [selected]);

  if (error) return <div className="p-6 text-sm text-status-err">{error}</div>;
  if (!runs) return <div className="p-6 text-sm text-muted-foreground">加载中…</div>;

  const filtered = filter === "all" ? runs : runs.filter((r) => r.status === filter);

  return (
    <div className="flex h-full flex-col gap-3 p-6">
      <div className="flex items-center gap-2">
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger className="h-8 w-[180px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部</SelectItem>
            {Object.keys(STATUS_TONES).map((s) => (
              <SelectItem key={s} value={s}>{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="flex-1" />
        <Button size="sm" variant="outline" onClick={() => void refresh()}>刷新</Button>
      </div>

      <div className="flex min-h-0 flex-1 gap-6">
        <ul className="w-80 shrink-0 space-y-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <li className="p-3 text-sm text-muted-foreground">没有匹配的 run</li>
          ) : (
            filtered.map((r) => (
              <li
                key={r.runId}
                onClick={() => setSelected(r.runId)}
                className={
                  "flex cursor-pointer items-center gap-2 rounded-md p-2 text-sm hover:bg-accent " +
                  (selected === r.runId ? "bg-accent ring-1 ring-border" : "")
                }
              >
                <span
                  className={"h-2 w-2 shrink-0 rounded-full " + (STATUS_TONES[r.status] ?? "bg-status-idle")}
                  title={r.status}
                />
                <span className="flex-1 truncate">{r.objective || "(no objective)"}</span>
                <span className="text-xs text-muted-foreground">{new Date(r.updatedAt).toLocaleString()}</span>
              </li>
            ))
          )}
        </ul>
        <div className="min-w-0 flex-1 overflow-y-auto">
          {detail ? <RunDetailView detail={detail} /> : (
            <div className="p-6 text-sm text-muted-foreground">选一个 run 查看详情</div>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <h3 className="mb-1.5 text-sm font-semibold">
        {title}{count !== undefined ? ` (${count})` : ""}
      </h3>
      {children}
    </div>
  );
}

function RunDetailView({ detail }: { detail: RunDetail }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <strong className="text-base">{detail.objective}</strong>
        <span className="text-xs text-muted-foreground">{detail.status}</span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>runId <code className="font-mono text-foreground">{detail.runId}</code></span>
        <span>cwd <code className="font-mono text-foreground">{detail.cwd}</code></span>
        {detail.preset && <span>preset <code className="font-mono text-foreground">{detail.preset}</code></span>}
        {detail.sessionId && <span>session <code className="font-mono text-foreground">{detail.sessionId.slice(0, 12)}</code></span>}
        <span>attempts {detail.attemptCount}</span>
      </div>
      {detail.error && <div className="rounded-md bg-status-err/10 p-2 text-sm text-status-err">{detail.error}</div>}
      {detail.summary && (
        <Section title="摘要"><div className="text-sm">{detail.summary}</div></Section>
      )}
      <Section title="检查点" count={detail.checkpoints.length}>
        {detail.checkpoints.length === 0 ? (
          <div className="text-sm text-muted-foreground">暂无</div>
        ) : (
          <ul className="space-y-2">
            {detail.checkpoints.map((c) => (
              <li key={c.checkpointId} className="rounded-md border p-2 text-sm">
                <div className="flex items-center justify-between">
                  <strong>{c.phase}</strong>
                  <span className="text-xs text-muted-foreground">{new Date(c.createdAt).toLocaleString()}</span>
                </div>
                <div>{c.summary}</div>
                {c.nextAction && <div className="mt-1 text-xs text-muted-foreground">下一步:{c.nextAction}</div>}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="产物" count={detail.artifacts.length}>
        {detail.artifacts.length === 0 ? (
          <div className="text-sm text-muted-foreground">暂无</div>
        ) : (
          <ul className="space-y-1 text-sm">
            {detail.artifacts.map((a) => (<li key={a}><code className="font-mono">{a}</code></li>))}
          </ul>
        )}
      </Section>
      <Section title="事件" count={detail.events.length}>
        {detail.events.length === 0 ? (
          <div className="text-sm text-muted-foreground">暂无</div>
        ) : (
          <ul className="space-y-1">
            {detail.events.slice().reverse().map((e) => (
              <li key={e.eventId} className="flex items-center justify-between text-sm">
                <span className="font-mono text-xs">{e.type}</span>
                <span className="text-xs text-muted-foreground">{new Date(e.timestamp).toLocaleTimeString()}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
