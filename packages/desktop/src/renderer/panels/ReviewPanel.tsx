import React, { useEffect, useState } from "react";
import { UnifiedDiffViewer } from "../diff/UnifiedDiffViewer";
import { ChangedFilesList } from "../diff/ChangedFilesList";
import "../styles/diff.css";

interface Props {
  /** Workspace root; null when no project is active. */
  cwd: string | null;
  /**
   * Files to focus, e.g. the set a chat "files changed" card edited. When
   * present, the first one is auto-selected so the panel opens on the most
   * relevant diff instead of the whole working tree.
   */
  files?: string[];
}

/**
 * Code-review panel: working-tree diff vs HEAD. Reuses the existing diff
 * components (UnifiedDiffViewer + ChangedFilesList) that already back the
 * in-chat FilesChangedCard — here they're hoisted into a side panel with a
 * changed-files sidebar.
 */
export function ReviewPanel({ cwd, files }: Props) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  // When the caller hands us a focus set (e.g. from a "files changed" card),
  // jump to its first file. Re-runs when the set identity changes.
  const focusKey = files?.join("\n") ?? "";
  useEffect(() => {
    if (files && files.length > 0) setSelectedFile(files[0]);
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
