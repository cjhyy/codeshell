import React, { useEffect, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import type { GitStatus } from "../../preload/types";
import { OpenWithMenu } from "../chat/OpenWithMenu";

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
        <div key={e.path} className="group/cf relative flex items-center">
          <button
            className={`changed-file ${selectedFile === e.path ? "selected" : ""}`}
            style={{ width: "100%", paddingRight: 24 }}
            onClick={() => onSelectFile(e.path)}
          >
            <span className={`changed-file-status status-${codeClass(e.code)}`}>{e.code.trim()}</span>
            <span className="changed-file-path">{e.path}</span>
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
