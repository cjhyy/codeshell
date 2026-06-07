import React, { useEffect, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import type { GitStatus } from "../../preload/types";
import { OpenWithMenu } from "../chat/OpenWithMenu";
import { filterByScope, type ReviewScope } from "./reviewScope";

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
  const [status, setStatus] = useState<GitStatus | null>(null);
  // Per-file +/- line counts (TODO 2.3a). Best-effort; absent → no badge.
  const [numstat, setNumstat] = useState<Record<string, { added: number; removed: number }>>({});

  useEffect(() => {
    let cancelled = false;
    void window.codeshell.getGitStatus(cwd).then((s) => {
      if (!cancelled) setStatus(s);
    });
    void window.codeshell.getGitNumstat?.(cwd).then((n) => {
      if (!cancelled) setNumstat(n ?? {});
    });
    return () => {
      cancelled = true;
    };
  }, [cwd, refreshKey]);

  if (!status) return <div className="diff-loading">loading status…</div>;
  // Filter the working-tree status to the active scope (TODO 2.3a). For "turn"
  // we keep only the files the turn touched, so 审查 opens on the turn's diff
  // instead of the whole tree.
  const entries = filterByScope(status.entries, scope, turnFiles);
  if (entries.length === 0) {
    return (
      <div className="diff-empty">
        {scope === "turn" ? "本轮没有可显示的变更文件" : "此范围内没有变更"}
      </div>
    );
  }

  return (
    <div className="changed-files">
      <button
        className={`changed-file ${selectedFile === null ? "selected" : ""}`}
        onClick={() => onSelectFile(null)}
      >
        <span className="changed-file-status">ALL</span>
        <span className="changed-file-path">全部({entries.length})</span>
      </button>
      {entries.map((e) => (
        <div key={e.path} className="group/cf relative flex items-center">
          <button
            className={`changed-file ${selectedFile === e.path ? "selected" : ""}`}
            style={{ width: "100%", paddingRight: 24 }}
            onClick={() => onSelectFile(e.path)}
          >
            <span className={`changed-file-status status-${codeClass(e.code)}`}>{e.code.trim()}</span>
            <span className="changed-file-path">{e.path}</span>
            {numstat[e.path] && (numstat[e.path].added > 0 || numstat[e.path].removed > 0) && (
              <span className="changed-file-stat">
                <span className="changed-file-added">+{numstat[e.path].added}</span>{" "}
                <span className="changed-file-removed">-{numstat[e.path].removed}</span>
              </span>
            )}
          </button>
          {/* e.path is relative to the repo — pass cwd so open/reveal resolve it. */}
          <OpenWithMenu path={e.path} cwd={cwd} align="end">
            <button
              type="button"
              title="打开方式"
              aria-label="打开方式"
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-background hover:text-foreground group-hover/cf:opacity-100 data-[state=open]:opacity-100"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </OpenWithMenu>
        </div>
      ))}
    </div>
  );
}

function codeClass(code: string): string {
  const trimmed = code.trim();
  if (trimmed.startsWith("?")) return "untracked";
  if (trimmed.startsWith("A")) return "added";
  if (trimmed.startsWith("D")) return "deleted";
  if (trimmed.startsWith("R")) return "renamed";
  return "modified";
}
