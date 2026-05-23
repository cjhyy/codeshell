import React, { useEffect, useState } from "react";
import type { GitStatus } from "../../preload/types";

interface Props {
  cwd: string;
  selectedFile: string | null;
  onSelectFile: (file: string | null) => void;
}

export function ChangedFilesList({ cwd, selectedFile, onSelectFile }: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.codeshell.getGitStatus(cwd).then((s) => {
      if (!cancelled) setStatus(s);
    });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  if (!status) return <div className="diff-loading">loading status…</div>;
  if (status.entries.length === 0) return <div className="diff-empty">working tree clean</div>;

  return (
    <div className="changed-files">
      <button
        className={`changed-file ${selectedFile === null ? "selected" : ""}`}
        onClick={() => onSelectFile(null)}
      >
        <span className="changed-file-status">ALL</span>
        <span className="changed-file-path">all changes</span>
      </button>
      {status.entries.map((e) => (
        <button
          key={e.path}
          className={`changed-file ${selectedFile === e.path ? "selected" : ""}`}
          onClick={() => onSelectFile(e.path)}
        >
          <span className={`changed-file-status status-${codeClass(e.code)}`}>{e.code.trim()}</span>
          <span className="changed-file-path">{e.path}</span>
        </button>
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
