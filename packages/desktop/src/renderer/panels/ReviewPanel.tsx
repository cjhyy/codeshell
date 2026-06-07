import React, { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { UnifiedDiffViewer } from "../diff/UnifiedDiffViewer";
import { ChangedFilesList } from "../diff/ChangedFilesList";
import { REVIEW_SCOPES, type ReviewScope } from "../diff/reviewScope";
import "../styles/diff.css";

interface Props {
  /** Workspace root; null when no project is active. */
  cwd: string | null;
  /**
   * Files the originating turn changed (from a chat "files changed" card).
   * When present we open in "本轮改动" scope showing exactly these — fixing the
   * old bug where 审查 dropped into the whole working tree (TODO 2.3a).
   */
  files?: string[];
  /**
   * The turn's diff SNAPSHOT (captured when the turn ran). In "本轮改动" scope
   * we show this instead of querying git, so a past turn's changes are still
   * viewable AFTER they're committed — git status would no longer surface them
   * (TODO 2.3a — "看不了之前 turn 的对比"修复).
   */
  turnDiff?: string;
}

/**
 * Code-review panel (TODO 2.3a). A scope selector switches what the file tree
 * shows — 本轮改动 / 未暂存 / 已暂存 / 全部未提交 — defaulting to the turn's own
 * files when opened from a card. Reuses UnifiedDiffViewer + ChangedFilesList.
 * (committed / branch / 上轮对话 ranges + a commit/push/PR action bar are a
 * later slice — see TODO 2.3a.)
 */
export function ReviewPanel({ cwd, files, turnDiff }: Props) {
  const hasTurnFiles = !!files && files.length > 0;
  const [scope, setScope] = useState<ReviewScope>(hasTurnFiles ? "turn" : "all");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // When the caller hands us a focus set (e.g. from a "files changed" card),
  // snap to its turn scope + first file. Re-runs when the set identity changes.
  const focusKey = files?.join("\n") ?? "";
  useEffect(() => {
    if (hasTurnFiles) {
      setScope("turn");
      setSelectedFile(files![0]);
    }
  }, [focusKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!cwd) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        请先选择一个项目
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-72 shrink-0 flex-col border-r border-border">
        {/* Scope selector + refresh (TODO 2.3a). "本轮改动" only offered when a
            turn handed us its files. */}
        <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
          <div className="flex min-w-0 flex-1 flex-wrap gap-1">
            {REVIEW_SCOPES.filter((s) => s.id !== "turn" || hasTurnFiles).map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  setScope(s.id);
                  setSelectedFile(null);
                }}
                className={`rounded px-1.5 py-0.5 text-[11px] ${
                  scope === s.id
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            title="刷新"
            aria-label="刷新"
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => setRefreshKey((k) => k + 1)}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <ChangedFilesList
            cwd={cwd}
            selectedFile={selectedFile}
            onSelectFile={setSelectedFile}
            scope={scope}
            turnFiles={files}
            refreshKey={refreshKey}
          />
        </div>
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        {scope === "turn" && turnDiff ? (
          // Authoritative turn-time snapshot — viewable even after the edits
          // were committed (git would no longer show them). Whole-turn diff;
          // file selection applies in the git-backed scopes.
          <UnifiedDiffViewer cwd={cwd} diffText={turnDiff} />
        ) : (
          <UnifiedDiffViewer cwd={cwd} file={selectedFile ?? undefined} />
        )}
      </div>
    </div>
  );
}
