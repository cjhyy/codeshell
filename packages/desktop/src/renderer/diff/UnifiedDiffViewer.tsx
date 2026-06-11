import React, { useEffect, useState } from "react";
import { MessageSquarePlus, ChevronRight, ChevronDown } from "lucide-react";
import { parseUnifiedDiff, type DiffFile } from "./parseUnifiedDiff";
import { CommentBox } from "../chat/CommentBox";
import { addAnchor } from "../chat/addAnchor";

interface Props {
  /** cwd to ask git for the diff. */
  cwd: string;
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
}

export function UnifiedDiffViewer({ cwd, file, diffText, range, onlyPath, mode }: Props) {
  const [diff, setDiff] = useState<DiffFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (diffText !== undefined) {
      setDiff(parseUnifiedDiff(diffText));
      setError(null);
      return () => {
        cancelled = true;
      };
    }
    const fetchDiff = range
      ? window.codeshell.getGitRangeDiff(cwd, range, file)
      : window.codeshell.getGitDiff(cwd, file, mode);
    void fetchDiff
      .then((raw) => {
        if (cancelled) return;
        setDiff(parseUnifiedDiff(raw));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(String(e instanceof Error ? e.message : e));
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, file, diffText, range, mode]);

  if (error) return <div className="diff-error">git diff failed: {error}</div>;
  if (!diff) return <div className="diff-loading">loading diff…</div>;
  const visible = onlyPath
    ? diff.filter((f) => (f.newPath ?? f.oldPath) === onlyPath)
    : diff;
  if (visible.length === 0) {
    return <div className="diff-empty">no changes</div>;
  }
  // Guard against rendering an enormous diff (e.g. a whole "branch vs base"
  // range): a per-line <tr> table with no virtualization froze the main thread
  // (couldn't even scroll) and leaked memory toward V8 OOM. Cap the total lines
  // rendered; past the cap, show a notice prompting the user to pick a single
  // file. (#5 ③ hang / ④ OOM)
  const totalLines = visible.reduce(
    (n, f) => n + f.hunks.reduce((m, h) => m + h.lines.length, 0),
    0,
  );
  const overCap = totalLines > MAX_RENDERED_LINES;
  const filesToRender = overCap ? capFiles(visible, MAX_RENDERED_LINES) : visible;
  return (
    <div className="diff-viewer">
      {overCap && (
        <div className="diff-empty px-2 py-1 text-xs text-muted-foreground">
          差异较大（{totalLines} 行），仅显示前 {MAX_RENDERED_LINES} 行。
        </div>
      )}
      {filesToRender.map((f) => (
        <DiffFileBlock key={f.newPath ?? f.oldPath ?? f.hunks[0]?.header ?? ""} file={f} />
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
function capFiles(diff: DiffFile[], budget: number): DiffFile[] {
  const out: DiffFile[] = [];
  let used = 0;
  for (const f of diff) {
    const lines = f.hunks.reduce((m, h) => m + h.lines.length, 0);
    if (out.length > 0 && used + lines > budget) break;
    out.push(f);
    used += lines;
  }
  return out;
}

function DiffFileBlock({ file }: { file: DiffFile }) {
  const title = file.newPath ?? file.oldPath ?? "(unknown)";
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
    <div className={`diff-file diff-file-${file.status}`}>
      <button
        type="button"
        className="diff-file-head"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        title={collapsed ? "展开" : "折叠"}
      >
        {collapsed ? (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className={`diff-file-status diff-file-status-${file.status}`}>
          {file.status}
        </span>
        <span className="diff-file-path">{title}</span>
        <span className="ml-auto shrink-0 pl-2 text-xs tabular-nums">
          <span className="text-status-ok">+{added}</span>{" "}
          <span className="text-status-err">-{removed}</span>
        </span>
      </button>
      {!collapsed && file.hunks.map((h, i) => (
        <div key={h.header || i} className="diff-hunk">
          <div className="diff-hunk-head">{h.header}</div>
          <table className="diff-table">
            <tbody>
              {h.lines.map((l, j) => {
                const key = `${i}:${j}`;
                const lineNo = l.newLine ?? l.oldLine ?? null;
                return (
                  <React.Fragment key={j}>
                    <tr className={`diff-line diff-line-${l.kind} group`}>
                      <td className="diff-lineno diff-lineno-old">{l.oldLine ?? ""}</td>
                      <td className="diff-lineno diff-lineno-new">{l.newLine ?? ""}</td>
                      <td className="diff-marker">
                        {l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}
                      </td>
                      <td className="diff-text">
                        {/* The line text keeps `white-space: pre` (from
                            .diff-text) so it extends and the hunk scrolls
                            horizontally; the comment button is positioned
                            relative to the row, not inline, so it doesn't
                            force-wrap or get lost off-screen on scroll. */}
                        <span className="relative block pr-6">
                          {l.text || " "}
                          <button
                            type="button"
                            aria-label="评论此行"
                            title="评论此行(加入输入框)"
                            className="diff-comment-btn absolute right-0 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-accent group-hover:opacity-100"
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
                            title={`${title}${lineNo != null ? `:${lineNo}` : ""}`}
                            onCancel={() => setCommenting(null)}
                            onSubmit={(comment) => {
                              addAnchor({
                                kind: "diff",
                                label: `${title.split("/").pop()}${lineNo != null ? `:${lineNo}` : ""}`,
                                locator: {
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
