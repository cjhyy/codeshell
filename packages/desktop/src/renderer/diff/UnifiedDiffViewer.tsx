import React, { useEffect, useState } from "react";
import { MessageSquarePlus } from "lucide-react";
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
}

export function UnifiedDiffViewer({ cwd, file, diffText }: Props) {
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
    void window.codeshell
      .getGitDiff(cwd, file)
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
  }, [cwd, file, diffText]);

  if (error) return <div className="diff-error">git diff failed: {error}</div>;
  if (!diff) return <div className="diff-loading">loading diff…</div>;
  if (diff.length === 0) {
    return <div className="diff-empty">no changes</div>;
  }
  return (
    <div className="diff-viewer">
      {diff.map((f, i) => (
        <DiffFileBlock key={i} file={f} />
      ))}
    </div>
  );
}

function DiffFileBlock({ file }: { file: DiffFile }) {
  const title = file.newPath ?? file.oldPath ?? "(unknown)";
  // Which line is currently being commented on, keyed by "hunkIdx:lineIdx".
  const [commenting, setCommenting] = useState<string | null>(null);

  return (
    <div className={`diff-file diff-file-${file.status}`}>
      <div className="diff-file-head">
        <span className={`diff-file-status diff-file-status-${file.status}`}>
          {file.status}
        </span>
        <span className="diff-file-path">{title}</span>
      </div>
      {file.hunks.map((h, i) => (
        <div key={i} className="diff-hunk">
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
                        <span className="inline-flex w-full items-center justify-between gap-2">
                          <span className="min-w-0 flex-1">{l.text}</span>
                          {/* Hover affordance: pin a comment to this line. */}
                          <button
                            type="button"
                            aria-label="评论此行"
                            title="评论此行(加入输入框)"
                            className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-accent group-hover:opacity-100"
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
