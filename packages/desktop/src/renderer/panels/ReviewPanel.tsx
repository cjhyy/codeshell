import React, { useEffect, useMemo, useState } from "react";
import { RefreshCw, ChevronDown, Check } from "lucide-react";
import { UnifiedDiffViewer } from "../diff/UnifiedDiffViewer";
import { parseUnifiedDiff } from "../diff/parseUnifiedDiff";
import { SimpleSelect } from "@/components/ui/simple-select";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
import { REVIEW_SCOPES, isRangeScope, type ReviewScope } from "../diff/reviewScope";
import type { GitCommit } from "../../preload/types";
import "../styles/diff.css";

const ALL_FILES = "__all__";

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
 * Code-review panel (TODO 2.3a). Full-width diff (Codex/GitLab style — no left
 * file-list sidebar). Scope chips top-left switch what's shown — 本轮改动 /
 * 未暂存 / 已暂存 / 全部未提交 / 最近提交 / 分支 vs base — defaulting to the
 * turn's own files when opened from a card. All changed files stack; long lines
 * scroll horizontally (see diff.css). (A commit/push/PR action bar is a later
 * slice — see TODO 2.3a.)
 */
export function ReviewPanel({ cwd, files, turnDiff }: Props) {
  const hasTurnFiles = !!files && files.length > 0;
  const [scope, setScope] = useState<ReviewScope>(hasTurnFiles ? "turn" : "all");
  // Turn-scope file filter for the dropdown (#5 ②). "" / ALL_FILES = show all.
  const [turnFileSel, setTurnFileSel] = useState<string>(ALL_FILES);
  const [refreshKey, setRefreshKey] = useState(0);
  // Total +/- for the current scope, reported by the diff viewer — shown next
  // to the scope dropdown (Codex style).
  const [stats, setStats] = useState<{ added: number; removed: number } | null>(null);

  // File list parsed out of the turn snapshot, to populate the dropdown.
  const turnFilePaths = useMemo(() => {
    if (!turnDiff) return [];
    return parseUnifiedDiff(turnDiff)
      .map((f) => f.newPath ?? f.oldPath)
      .filter((p): p is string => !!p);
  }, [turnDiff]);
  // Resolved git range for committed/branch scopes (TODO 2.3a). null = working tree.
  const [range, setRange] = useState<string | null>(null);
  // The commit picked from the 提交 submenu (committed scope diffs <hash>^..<hash>).
  // null = no specific commit picked → default to the most recent (HEAD~1..HEAD).
  const [selectedCommit, setSelectedCommit] = useState<GitCommit | null>(null);
  // Recent commits for the 提交 submenu, loaded lazily when it opens.
  const [commits, setCommits] = useState<GitCommit[] | null>(null);

  // Resolve the diff range when in a committed/branch scope: "提交" diffs the
  // picked commit (<hash>^..<hash>) or, with none picked, the most recent
  // (HEAD~1..HEAD); "分支 vs base" diffs against the base branch (main/master/
  // upstream), falling back to the last commit if no base exists.
  useEffect(() => {
    let cancelled = false;
    if (!isRangeScope(scope) || !cwd) {
      setRange(null);
      return;
    }
    if (scope === "committed") {
      setRange(selectedCommit ? `${selectedCommit.hash}^..${selectedCommit.hash}` : "HEAD~1..HEAD");
      return;
    }
    void window.codeshell.getGitBranchBase?.(cwd).then((base) => {
      if (cancelled) return;
      setRange(base ? `${base}...HEAD` : "HEAD~1..HEAD");
    });
    return () => {
      cancelled = true;
    };
  }, [scope, cwd, refreshKey, selectedCommit]);

  // Lazy-load recent commits the first time the 提交 submenu is opened.
  const loadCommits = (): void => {
    if (commits !== null || !cwd) return;
    void window.codeshell
      .getGitRecentCommits(cwd, 20)
      .then((cs) => setCommits(cs))
      .catch(() => setCommits([]));
  };

  // When the caller hands us a focus set (e.g. from a "files changed" card),
  // snap to its turn scope + first file. Re-runs when the set identity changes.
  const focusKey = files?.join("\n") ?? "";
  useEffect(() => {
    if (hasTurnFiles) setScope("turn");
  }, [focusKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Label for the scope dropdown trigger. In committed scope, show the picked
  // commit's subject (or "最近提交" when none picked yet).
  const triggerLabel =
    scope === "committed"
      ? selectedCommit
        ? selectedCommit.subject
        : "最近提交"
      : (REVIEW_SCOPES.find((s) => s.id === scope)?.label ?? "审查范围");

  if (!cwd) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        请先选择一个项目
      </div>
    );
  }

  return (
    // No left file-list sidebar — the diff gets the full width (Codex/GitLab
    // style). Scope chips live top-left; a file dropdown narrows the turn
    // snapshot. Other scopes stack all changed files top-to-bottom; each hunk
    // scrolls horizontally (see diff.css) so long lines aren't force-wrapped.
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Top bar: scope dropdown (top-left, with a 提交 submenu listing recent
          commits) + optional file dropdown + refresh. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-2 py-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="选择审查范围"
              className="flex h-8 shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 text-xs hover:bg-accent"
            >
              <span className="max-w-[180px] truncate">{triggerLabel}</span>
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[160px]">
            {REVIEW_SCOPES.filter((s) => s.id === "turn" ? hasTurnFiles : s.id !== "committed").map(
              (s) => (
                <DropdownMenuItem
                  key={s.id}
                  onSelect={() => {
                    setScope(s.id);
                    setSelectedCommit(null);
                  }}
                >
                  <span className="flex-1">{s.label}</span>
                  {scope === s.id && <Check className="h-3.5 w-3.5" />}
                </DropdownMenuItem>
              ),
            )}
            {/* 提交 ›: hover to list recent commits (Codex style). */}
            <DropdownMenuSub onOpenChange={(open) => open && loadCommits()}>
              <DropdownMenuSubTrigger>
                <span className="flex-1">提交</span>
                {scope === "committed" && <Check className="mr-1 h-3.5 w-3.5" />}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-[60vh] max-w-[360px] overflow-auto">
                {commits === null ? (
                  <DropdownMenuItem disabled>加载中…</DropdownMenuItem>
                ) : commits.length === 0 ? (
                  <DropdownMenuItem disabled>没有提交</DropdownMenuItem>
                ) : (
                  commits.map((c) => (
                    <DropdownMenuItem
                      key={c.hash}
                      onSelect={() => {
                        setSelectedCommit(c);
                        setScope("committed");
                      }}
                    >
                      <span className="min-w-0 flex-1 truncate">{c.subject}</span>
                      <span className="ml-2 shrink-0 text-[10px] text-muted-foreground">
                        {c.relativeDate}
                      </span>
                      {selectedCommit?.hash === c.hash && <Check className="ml-1 h-3.5 w-3.5" />}
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
        {stats && (stats.added > 0 || stats.removed > 0) && (
          <span className="shrink-0 text-xs tabular-nums">
            <span className="text-status-ok">+{stats.added}</span>{" "}
            <span className="text-status-err">-{stats.removed}</span>
          </span>
        )}
        {scope === "turn" && turnDiff && turnFilePaths.length > 1 && (
          <SimpleSelect
            size="sm"
            ariaLabel="选择文件"
            value={turnFileSel}
            onChange={setTurnFileSel}
            options={[
              { value: ALL_FILES, label: `全部文件（${turnFilePaths.length}）` },
              ...turnFilePaths.map((p) => ({ value: p, label: p })),
            ]}
          />
        )}
        <button
          type="button"
          title="刷新"
          aria-label="刷新"
          className="ml-auto shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => setRefreshKey((k) => k + 1)}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Full-width diff. */}
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {scope === "turn" && turnDiff ? (
          // Authoritative turn-time snapshot — viewable even after the edits
          // were committed (git would no longer show them). The dropdown above
          // narrows the flat snapshot to one file (#5 ②).
          <UnifiedDiffViewer
            cwd={cwd}
            diffText={turnDiff}
            onlyPath={turnFileSel === ALL_FILES ? null : turnFileSel}
            onStats={setStats}
          />
        ) : isRangeScope(scope) ? (
          // Committed/branch scopes diff the resolved git range.
          <UnifiedDiffViewer
            key={`${scope}:${refreshKey}`}
            cwd={cwd}
            range={range ?? undefined}
            onStats={setStats}
          />
        ) : (
          // Working-tree scopes — the `mode` (= scope) picks the git command so
          // 未暂存 / 已暂存 / 全部未提交 return DIFFERENT diffs (they used to all
          // return the same one — getGitDiff ignored the scope). All changed
          // files stack (the viewer caps huge diffs to stay responsive).
          <UnifiedDiffViewer
            key={`${scope}:${refreshKey}`}
            cwd={cwd}
            mode={scope as "unstaged" | "staged" | "all"}
            onStats={setStats}
          />
        )}
      </div>
    </div>
  );
}
