import React, { useState } from "react";
import { UnifiedDiffViewer } from "../diff/UnifiedDiffViewer";
import { ChangedFilesList } from "../diff/ChangedFilesList";
import "../styles/diff.css";

interface Props {
  /** Workspace root; null when no project is active. */
  cwd: string | null;
}

/**
 * Code-review panel: working-tree diff vs HEAD. Reuses the existing diff
 * components (UnifiedDiffViewer + ChangedFilesList) that already back the
 * in-chat FilesChangedCard — here they're hoisted into a full-screen view
 * with a changed-files sidebar.
 */
export function ReviewPanel({ cwd }: Props) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

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
        <div className="shrink-0 border-b border-border px-3 py-2 text-sm font-medium text-foreground">
          变更文件
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <ChangedFilesList cwd={cwd} selectedFile={selectedFile} onSelectFile={setSelectedFile} />
        </div>
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        <UnifiedDiffViewer cwd={cwd} file={selectedFile ?? undefined} />
      </div>
    </div>
  );
}
