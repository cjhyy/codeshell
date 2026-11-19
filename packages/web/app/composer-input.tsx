import React from "react";
import type { WorkbenchController } from "./workbench-types.js";

type KeyLike = {
  key: string;
  shiftKey?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
  isComposing?: boolean;
};

/**
 * True while an input method (Chinese/Japanese IME) owns the Enter key. Safari
 * reports the confirming Enter with `isComposing === false` but keyCode 229, so
 * both signals are needed — the same guard Desktop's composer uses.
 */
export function isImeComposing(event: KeyLike): boolean {
  return (
    event.isComposing === true ||
    event.nativeEvent?.isComposing === true ||
    event.keyCode === 229 ||
    event.nativeEvent?.keyCode === 229
  );
}

/** Enter submits, Shift+Enter breaks the line; phones keep Enter as a newline. */
export function submitsOnEnter(event: KeyLike, narrow: boolean): boolean {
  return !narrow && event.key === "Enter" && !event.shiftKey && !isImeComposing(event);
}

/** Pasted or dropped items that are real files (not plain text). */
export function transferredFiles(data: DataTransfer | null | undefined): FileList | null {
  return data?.files && data.files.length > 0 ? data.files : null;
}

/**
 * Paste and drag-and-drop attachments for the composer, matching Desktop: files
 * pasted into the textarea or dropped on the composer go through the same
 * `addFiles` path as the attach button. Plain-text paste is left alone.
 */
export function useComposerFileTransfer(
  enabled: boolean,
  addFiles: WorkbenchController["addFiles"],
) {
  const [dragging, setDragging] = React.useState(false);
  const depth = React.useRef(0);
  React.useEffect(() => {
    if (!enabled) {
      depth.current = 0;
      setDragging(false);
    }
  }, [enabled]);
  const hasFiles = (event: React.DragEvent) =>
    Array.from(event.dataTransfer?.types ?? []).includes("Files");
  return {
    dragging,
    onPaste: (event: React.ClipboardEvent) => {
      const files = enabled ? transferredFiles(event.clipboardData) : null;
      if (!files) return;
      event.preventDefault();
      void addFiles(files);
    },
    onDragEnter: (event: React.DragEvent) => {
      if (!enabled || !hasFiles(event)) return;
      event.preventDefault();
      depth.current += 1;
      setDragging(true);
    },
    onDragOver: (event: React.DragEvent) => {
      if (!enabled || !hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: () => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDrop: (event: React.DragEvent) => {
      depth.current = 0;
      setDragging(false);
      const files = enabled ? transferredFiles(event.dataTransfer) : null;
      if (!files) return;
      event.preventDefault();
      void addFiles(files);
    },
  };
}

/** Connection status line; offers an immediate retry once the link is closed. */
export function ConnectionBanner({ controller }: { controller: WorkbenchController }) {
  const { connection } = controller;
  if (connection === "open") return null;
  return (
    <div className="banner" role="status">
      {controller.connectionMessage ||
        `连接${connection === "connecting" ? "中…" : "已断开，重连中…"}`}
      {connection === "closed" && controller.retryConnection ? (
        <button className="ghost" onClick={() => controller.retryConnection?.()}>
          立即重连
        </button>
      ) : null}
    </div>
  );
}
