import React, { useEffect, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import type { GitStatus } from "../../preload/types";
import { OpenWithMenu } from "../chat/OpenWithMenu";
import { filterByScope, isRangeScope, type ReviewScope } from "./reviewScope";
import type { GitStatusEntry } from "../../preload/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useT } from "../i18n/I18nProvider";

interface Props {
  cwd: string;
  selectedFile: string | null;
  onSelectFile: (file: string | null) => void;
  /** Active review scope (TODO 2.3a). Defaults to "all" for back-compat. */
  scope?: ReviewScope;
  /** Files the originating turn changed — the universe for scope="turn". */
  turnFiles?: string[];
  /** Re-fetch trigger: bump to reload git status (e.g. after刷新/外部变更). */
  refreshKey?: number;
}

export function ChangedFilesList({
  cwd,
  selectedFile,
  onSelectFile,
  scope = "all",
  turnFiles,
  refreshKey,
}: Props) {
  const { t } = useT();
  const [status, setStatus] = useState<GitStatus | null>(null);
  // Entries for committed/branch range scopes (TODO 2.3a). null until loaded.
  const [rangeEntries, setRangeEntries] = useState<GitStatusEntry[] | null>(null);
  // Per-file +/- line counts (TODO 2.3a). Best-effort; absent → no badge.
  const [numstat, setNumstat] = useState<Record<string, { added: number; removed: number }>>({});

  useEffect(() => {
    let cancelled = false;
    if (isRangeScope(scope)) {
      // Committed/branch scopes diff a committed range, not the working tree.
      setStatus(null);
      void (async () => {
        let range = "HEAD~1..HEAD";
        if (scope === "branch") {
          const base = await window.codeshell.getGitBranchBase?.(cwd);
          range = base ? `${base}...HEAD` : "HEAD~1..HEAD";
        }
        const res = await window.codeshell.getGitRangeChanges?.(cwd, range);
        if (cancelled) return;
        setRangeEntries(res?.entries ?? []);
        setNumstat(res?.numstat ?? {});
      })();
    } else {
      setRangeEntries(null);
      void window.codeshell.getGitStatus(cwd).then((s) => {
        if (!cancelled) setStatus(s);
      });
      void window.codeshell.getGitNumstat?.(cwd).then((n) => {
        if (!cancelled) setNumstat(n ?? {});
      });
    }
    return () => {
      cancelled = true;
    };
  }, [cwd, refreshKey, scope]);

  // Range scopes (committed/branch) come pre-filtered from git; working-tree
  // scopes are filtered locally from git status (TODO 2.3a). For "turn" we keep
  // only the files the turn touched, so 审查 opens on the turn's diff.
  let entries: GitStatusEntry[];
  if (isRangeScope(scope)) {
    if (!rangeEntries) return <div className="p-3 text-sm text-muted-foreground">{t("panels.changedFiles.loadingStatus")}</div>;
    entries = rangeEntries;
  } else {
    if (!status) return <div className="p-3 text-sm text-muted-foreground">{t("panels.changedFiles.loadingStatus")}</div>;
    entries = filterByScope(status.entries, scope, turnFiles);
  }
  if (entries.length === 0) {
    return (
      <div className="p-3 text-sm text-muted-foreground">
        {scope === "turn" ? t("panels.changedFiles.turnNoChanges") : t("panels.changedFiles.scopeNoChanges")}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        variant="ghost"
        className={cn(
          "h-auto justify-start gap-2 rounded-md px-2 py-1.5 text-left",
          selectedFile === null && "bg-accent text-accent-foreground",
        )}
        onClick={() => onSelectFile(null)}
      >
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">ALL</span>
        <span className="min-w-0 flex-1 truncate text-sm">{t("panels.changedFiles.all", { count: entries.length })}</span>
      </Button>
      {entries.map((e) => (
        <div key={e.path} className="group/cf relative flex items-center">
          <Button
            type="button"
            variant="ghost"
            className={cn(
              "h-auto w-full justify-start gap-2 rounded-md px-2 py-1.5 pr-7 text-left",
              selectedFile === e.path && "bg-accent text-accent-foreground",
            )}
            onClick={() => onSelectFile(e.path)}
          >
            <span className={cn("shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]", codeTone(e.code))}>{e.code.trim()}</span>
            <span className="min-w-0 flex-1 truncate text-sm">{e.path}</span>
            {numstat[e.path] && (numstat[e.path].added > 0 || numstat[e.path].removed > 0) && (
              <span className="shrink-0 text-xs tabular-nums">
                <span className="text-status-ok">+{numstat[e.path].added}</span>{" "}
                <span className="text-status-err">-{numstat[e.path].removed}</span>
              </span>
            )}
          </Button>
          {/* e.path is relative to the repo — pass cwd so open/reveal resolve it. */}
          <OpenWithMenu path={e.path} cwd={cwd} align="end">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title={t("panels.common.openWith")}
              aria-label={t("panels.common.openWith")}
              className="absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2 text-muted-foreground opacity-0 hover:bg-background hover:text-foreground group-hover/cf:opacity-100 data-[state=open]:opacity-100"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </OpenWithMenu>
        </div>
      ))}
    </div>
  );
}

function codeTone(code: string): string {
  const trimmed = code.trim();
  if (trimmed.startsWith("?")) return "bg-muted text-muted-foreground";
  if (trimmed.startsWith("A")) return "bg-status-ok/10 text-status-ok";
  if (trimmed.startsWith("D")) return "bg-status-err/10 text-status-err";
  if (trimmed.startsWith("R")) return "bg-status-warn/10 text-status-warn";
  return "bg-status-running/10 text-status-running";
}
