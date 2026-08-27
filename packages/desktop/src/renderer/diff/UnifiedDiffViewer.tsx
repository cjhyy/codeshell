import React, { useEffect, useState } from "react";
import { MessageSquarePlus, ChevronRight, ChevronDown, ExternalLink } from "lucide-react";
import { parseUnifiedDiff, type DiffFile } from "./parseUnifiedDiff";
import { CommentBox } from "../chat/CommentBox";
import { addAnchor } from "../chat/addAnchor";
import { openFileTarget } from "../chat/openWith";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useT } from "../i18n/I18nProvider";
import type {
  ReviewGitDiffRequest,
  ReviewRepositoryError,
  ReviewRepositoryIdentity,
} from "../../preload/types";

interface Props {
  /** cwd to ask git for the diff. */
  cwd: string;
  /** Session-authoritative aggregate Review query. cwd remains display/open context only. */
  reviewSessionId?: string;
  reviewRequest?: ReviewGitDiffRequest;
  /** Optional file path to limit the diff. */
  file?: string;
  /** Optional session-scoped diff text. When present, do not ask Git. */
  diffText?: string;
  /**
   * Optional committed range (e.g. "HEAD~1..HEAD" or "main...HEAD"). When set,
   * diff the range instead of the working tree (TODO 2.3a — committed/branch).
   */
  range?: string;
  /**
   * Optional path filter applied to a parsed `diffText` — render only the file
   * matching this path. Lets the turn-scope dropdown narrow the flat snapshot
   * to one file (#5 ②). Ignored on the git-backed path (use `file` there).
   */
  onlyPath?: string | null;
  /**
   * Which uncommitted changes to diff (working-tree scopes). unstaged →
   * `git diff`; staged → `git diff --cached`; all → `git diff HEAD`. Without
   * this, 未暂存/已暂存/全部 all returned the same diff. Ignored when `range`
   * (committed/branch scope) or `diffText` (turn snapshot) is set.
   */
  mode?: "unstaged" | "staged" | "all";
  /**
   * Reports the total added/removed line counts across the rendered diff,
   * whenever it (re)loads. Lets a parent (e.g. ReviewPanel) show a "+N -M"
   * summary next to its scope selector without re-fetching the diff itself.
   */
  onStats?: (stats: { added: number; removed: number }) => void;
}

interface LoadedDiffFile {
  file: DiffFile;
  rootId: string;
  repoRoot: string;
  key: string;
}

interface LoadedDiff {
  files: LoadedDiffFile[];
  errors: ReviewRepositoryError[];
}

export function reviewDiffFileKey(
  repository: Pick<ReviewRepositoryIdentity, "rootId" | "repoRoot">,
  file: DiffFile,
  index: number,
): string {
  return [
    repository.rootId,
    repository.repoRoot,
    file.newPath ?? file.oldPath ?? file.hunks[0]?.header ?? "",
    String(index),
  ].join("\0");
}

function loadedFiles(
  repository: Pick<ReviewRepositoryIdentity, "rootId" | "repoRoot">,
  raw: string,
): LoadedDiffFile[] {
  return parseUnifiedDiff(raw).map((parsed, index) => ({
    file: parsed,
    rootId: repository.rootId,
    repoRoot: repository.repoRoot,
    key: reviewDiffFileKey(repository, parsed, index),
  }));
}

function absoluteReviewPath(repoRoot: string, file: string): string {
  const separator = repoRoot.includes("\\") ? "\\" : "/";
  return `${repoRoot.replace(/[\\/]+$/, "")}${separator}${file.replace(/^\.\//, "")}`;
}

export function UnifiedDiffViewer({
  cwd,
  reviewSessionId,
  reviewRequest,
  file,
  diffText,
  range,
  onlyPath,
  mode,
  onStats,
}: Props) {
  const { t } = useT();
  const [diff, setDiff] = useState<LoadedDiff | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (diffText !== undefined) {
      setDiff({
        files: loadedFiles({ rootId: "snapshot", repoRoot: cwd }, diffText),
        errors: [],
      });
      setError(null);
      return () => {
        cancelled = true;
      };
    }
    setError(null);
    setDiff(null);
    if (!reviewSessionId || !reviewRequest) {
      setError("review requires Session authority");
      return () => {
        cancelled = true;
      };
    }
    const fetchDiff = window.codeshell.getReviewDiff(reviewSessionId, reviewRequest);
    void fetchDiff
      .then((result) => {
        if (cancelled) return;
        setDiff({
          files: result.repositories.flatMap((repository) =>
            loadedFiles(repository, repository.diff),
          ),
          errors: result.errors,
        });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setDiff(null);
        setError(String(e instanceof Error ? e.message : e));
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, reviewSessionId, reviewRequest, file, diffText, range, mode]);

  // Report total +/- to the parent whenever the diff (re)loads. Computed over
  // the full parsed diff (not the onlyPath-filtered view) so the summary
  // reflects the whole scope. onStats is intentionally out of the deps —
  // including an unstable callback would loop; we only re-report on diff change.
  useEffect(() => {
    if (!onStats || !diff) return;
    let added = 0;
    let removed = 0;
    for (const loaded of diff.files) {
      for (const h of loaded.file.hunks) {
        for (const l of h.lines) {
          if (l.kind === "add") added++;
          else if (l.kind === "del") removed++;
        }
      }
    }
    onStats({ added, removed });
  }, [diff]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error)
    return (
      <div className="rounded-md bg-status-err/10 p-3 text-sm text-status-err">
        {t("panels.diff.gitDiffFailed", { error })}
      </div>
    );
  if (!diff)
    return <div className="p-3 text-sm text-muted-foreground">{t("panels.diff.loadingDiff")}</div>;
  const visible = onlyPath
    ? diff.files.filter((loaded) => (loaded.file.newPath ?? loaded.file.oldPath) === onlyPath)
    : diff.files;
  if (visible.length === 0 && diff.errors.length === 0) {
    return <div className="p-3 text-sm text-muted-foreground">{t("panels.diff.noChanges")}</div>;
  }
  // Guard against rendering an enormous diff (e.g. a whole "branch vs base"
  // range): a per-line <tr> table with no virtualization froze the main thread
  // (couldn't even scroll) and leaked memory toward V8 OOM. Cap the total lines
  // rendered; past the cap, show a notice prompting the user to pick a single
  // file. (#5 ③ hang / ④ OOM)
  const totalLines = visible.reduce(
    (n, loaded) => n + loaded.file.hunks.reduce((m, h) => m + h.lines.length, 0),
    0,
  );
  const overCap = totalLines > MAX_RENDERED_LINES;
  const filesToRender = overCap ? capFiles(visible, MAX_RENDERED_LINES) : visible;
  const showRepository = new Set(visible.map((entry) => entry.repoRoot)).size > 1;
  return (
    <div className="flex min-w-0 flex-col gap-3 overflow-x-auto text-sm">
      {diff.errors.map((repositoryError) => (
        <div
          key={`${repositoryError.operation}:${repositoryError.repoRoot ?? repositoryError.rootId}`}
          className="rounded-md bg-status-err/10 p-3 text-sm text-status-err"
        >
          {t("panels.diff.gitDiffFailed", {
            error: `[${repositoryError.repoRoot ?? repositoryError.rootId}] ${repositoryError.message}`,
          })}
        </div>
      ))}
      {overCap && (
        <div className="rounded-md bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
          {t("panels.diff.largeDiff", { total: totalLines, max: MAX_RENDERED_LINES })}
        </div>
      )}
      {filesToRender.map((loaded) => (
        <DiffFileBlock
          key={loaded.key}
          file={loaded.file}
          cwd={loaded.repoRoot}
          repoRoot={loaded.repoRoot}
          showRepository={showRepository}
        />
      ))}
    </div>
  );
}

/** Upper bound on rendered diff lines before we stop and ask the user to pick a
 *  single file. A per-line table past this size blocks the main thread. */
const MAX_RENDERED_LINES = 2000;

/** Keep whole files from the front of the diff until adding the next one would
 *  exceed the line budget. Always returns at least the first file so something
 *  shows. */
function capFiles(diff: LoadedDiffFile[], budget: number): LoadedDiffFile[] {
  const out: LoadedDiffFile[] = [];
  let used = 0;
  for (const loaded of diff) {
    const lines = loaded.file.hunks.reduce((m, h) => m + h.lines.length, 0);
    if (out.length > 0 && used + lines > budget) break;
    out.push(loaded);
    used += lines;
  }
  return out;
}

function DiffFileBlock({
  file,
  cwd,
  repoRoot,
  showRepository,
}: {
  file: DiffFile;
  cwd: string;
  repoRoot: string;
  showRepository: boolean;
}) {
  const { t } = useT();
  const title = file.newPath ?? file.oldPath ?? t("panels.diff.unknownFile");
  // Which line is currently being commented on, keyed by "hunkIdx:lineIdx".
  const [commenting, setCommenting] = useState<string | null>(null);
  // Collapse a file's diff by clicking its header (GitLab/GitHub style) — when
  // many files stack in the review panel, this lets the user fold the ones
  // they're done with instead of scrolling past a long flat list.
  const [collapsed, setCollapsed] = useState(false);

  // Per-file +/- counts for the header (handy when collapsed).
  let added = 0;
  let removed = 0;
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if (l.kind === "add") added++;
      else if (l.kind === "del") removed++;
    }
  }

  return (
    <div className="overflow-hidden rounded-md border bg-card">
      <Button
        type="button"
        variant="ghost"
        className="h-auto w-full justify-start gap-2 rounded-none border-b px-3 py-2 text-left"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        title={collapsed ? t("panels.diff.expand") : t("panels.diff.collapse")}
      >
        {collapsed ? (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        {/* "‎" (LRM) keeps the path reading LTR while direction:rtl clips
            the ellipsis at the START — see .diff-file-path. */}
        <span className="flex min-w-0 flex-1 flex-col">
          {showRepository && (
            <span className="truncate font-mono text-[10px] text-muted-foreground" title={repoRoot}>
              {"\u200e" + repoRoot}
            </span>
          )}
          <span className="truncate font-mono text-xs" title={title}>
            {"\u200e" + title}
          </span>
        </span>
        {/* Status as a symbol (Codex style), not a text label: added → green
            dot, deleted → red dash, renamed → amber dot; modified shows
            nothing (the +/- counts already convey it). */}
        {file.status === "added" && (
          <span
            className="shrink-0 h-2 w-2 rounded-full bg-status-ok"
            title={t("panels.diff.added")}
            aria-label={t("panels.diff.added")}
          />
        )}
        {file.status === "deleted" && (
          <span
            className="shrink-0 h-0.5 w-2.5 rounded bg-status-err"
            title={t("panels.diff.deleted")}
            aria-label={t("panels.diff.deleted")}
          />
        )}
        {file.status === "renamed" && (
          <span
            className="shrink-0 h-2 w-2 rounded-full bg-status-warn"
            title={t("panels.diff.renamed")}
            aria-label={t("panels.diff.renamed")}
          />
        )}
        <span className="shrink-0 pl-2 text-xs tabular-nums">
          <span className="text-status-ok">+{added}</span>{" "}
          <span className="text-status-err">-{removed}</span>
        </span>
        {/* Open in the in-app file panel (⌘/Ctrl → OS), matching path links. A
            faux button span since the header itself is interactive; nested
            interactive controls are invalid HTML. */}
        <span
          role="button"
          tabIndex={0}
          aria-label={t("panels.diff.openFile")}
          title={t("panels.diff.openFile")}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            openFileTarget(e, { path: absoluteReviewPath(repoRoot, title), cwd });
          }}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </span>
      </Button>
      {!collapsed &&
        file.hunks.map((h, i) => (
          <div key={h.header || i} className="overflow-x-auto border-b last:border-b-0">
            <div className="border-b bg-muted/40 px-3 py-1 font-mono text-xs text-muted-foreground">
              {h.header}
            </div>
            <table className="w-full border-collapse font-mono text-xs">
              <tbody>
                {h.lines.map((l, j) => {
                  const key = `${i}:${j}`;
                  const lineNo = l.newLine ?? l.oldLine ?? null;
                  return (
                    <React.Fragment key={j}>
                      <tr className={cn("group", lineTone(l.kind))}>
                        <td className="w-12 select-none border-r px-2 py-0.5 text-right tabular-nums text-muted-foreground">
                          {l.oldLine ?? ""}
                        </td>
                        <td className="w-12 select-none border-r px-2 py-0.5 text-right tabular-nums text-muted-foreground">
                          {l.newLine ?? ""}
                        </td>
                        <td className="w-6 select-none border-r px-2 py-0.5 text-center text-muted-foreground">
                          {l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}
                        </td>
                        <td className="min-w-[520px] whitespace-pre px-2 py-0.5">
                          {/* The line text keeps `white-space: pre` (from
                            .diff-text) so it extends and the hunk scrolls
                            horizontally; the comment button is positioned
                            relative to the row, not inline, so it doesn't
                            force-wrap or get lost off-screen on scroll. */}
                          <span className="relative block pr-6">
                            {l.text || " "}
                            <button
                              type="button"
                              aria-label={t("panels.diff.commentThisLine")}
                              title={t("panels.diff.commentThisLineTitle")}
                              className="absolute right-0 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-accent group-hover:opacity-100"
                              onClick={() => setCommenting(commenting === key ? null : key)}
                            >
                              <MessageSquarePlus size={12} />
                            </button>
                          </span>
                        </td>
                      </tr>
                      {commenting === key && (
                        <tr>
                          <td colSpan={4} className="px-2">
                            <CommentBox
                              title={`${showRepository ? `${repoRoot}:` : ""}${title}${lineNo != null ? `:${lineNo}` : ""}`}
                              onCancel={() => setCommenting(null)}
                              onSubmit={(comment) => {
                                addAnchor({
                                  kind: "diff",
                                  label: `${title.split("/").pop()}${lineNo != null ? `:${lineNo}` : ""}`,
                                  locator: {
                                    ...(showRepository ? { 仓库: repoRoot } : {}),
                                    文件: title,
                                    ...(lineNo != null ? { 行号: String(lineNo) } : {}),
                                    代码: l.text.trim().slice(0, 200),
                                  },
                                  comment,
                                });
                                setCommenting(null);
                              }}
                            />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
    </div>
  );
}

function lineTone(kind: string): string {
  if (kind === "add") return "bg-status-ok/10";
  if (kind === "del") return "bg-status-err/10";
  return "";
}
