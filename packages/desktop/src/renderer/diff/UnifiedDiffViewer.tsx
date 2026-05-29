import React, { useEffect, useState } from "react";
import { parseUnifiedDiff, type DiffFile } from "./parseUnifiedDiff";

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
              {h.lines.map((l, j) => (
                <tr key={j} className={`diff-line diff-line-${l.kind}`}>
                  <td className="diff-lineno diff-lineno-old">{l.oldLine ?? ""}</td>
                  <td className="diff-lineno diff-lineno-new">{l.newLine ?? ""}</td>
                  <td className="diff-marker">
                    {l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}
                  </td>
                  <td className="diff-text">{l.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
