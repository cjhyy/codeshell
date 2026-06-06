import React, { useEffect, useState } from "react";
import { X, Download, Copy, FolderOpen, Check } from "lucide-react";

/** Pure decision so the close behavior is unit-testable without a DOM. */
export function shouldCloseOnKey(key: string): boolean {
  return key === "Escape";
}

export interface LightboxProps {
  /** Display source — a `data:` URL (so it renders under the CSP). */
  src: string;
  alt: string;
  onClose: () => void;
  /**
   * On-disk path of the image when it's file-backed (generated images,
   * screenshots, files referenced in the answer). Enables "copy path" and
   * "reveal in folder"; absent for pasted/dragged attachments that live only
   * as a data URL.
   */
  path?: string | null;
  /** Workspace dir, used to resolve a relative `path` for reveal/open. */
  cwd?: string | null;
  /** Suggested download filename (falls back to the path basename / a stamp). */
  name?: string | null;
}

/**
 * Full-screen image viewer. Click the backdrop or press Escape to close.
 * Toolbar offers download (always, via the data URL), and — when the image is
 * file-backed — copy path / reveal in folder.
 */
export function Lightbox({ src, alt, onClose, path, cwd, name }: LightboxProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (shouldCloseOnKey(e.key)) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const filename = name ?? (path ? path.split(/[\\/]/).pop() ?? null : null) ?? alt;

  const onDownload = (): void => {
    void window.codeshell.saveImage(src, { name: filename });
  };
  const onCopyPath = (): void => {
    if (!path) return;
    void navigator.clipboard.writeText(path);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  const onReveal = (): void => {
    if (!path) return;
    void window.codeshell.openPath(path, cwd ?? undefined).then((abs) => {
      // openPath resolves the abs path; reveal that so we land on the file.
      void window.codeshell.revealInFinder(abs ?? path);
    });
  };

  return (
    <div className="lightbox-backdrop" onMouseDown={onClose}>
      <div className="lightbox-shell" onMouseDown={(e) => e.stopPropagation()}>
        <div className="lightbox-toolbar">
          <div className="lightbox-title" title={path ?? alt}>
            {alt}
          </div>
          <div className="lightbox-actions">
            <button
              type="button"
              className="lightbox-icon-button"
              aria-label="下载"
              title="下载"
              onClick={onDownload}
            >
              <Download size={16} />
            </button>
            {path && (
              <button
                type="button"
                className="lightbox-icon-button"
                aria-label="复制路径"
                title={copied ? "已复制" : "复制路径"}
                onClick={onCopyPath}
              >
                {copied ? <Check size={16} /> : <Copy size={16} />}
              </button>
            )}
            {path && (
              <button
                type="button"
                className="lightbox-icon-button"
                aria-label="在文件夹中显示"
                title="在文件夹中显示"
                onClick={onReveal}
              >
                <FolderOpen size={16} />
              </button>
            )}
            <button
              type="button"
              className="lightbox-icon-button"
              aria-label="关闭"
              title="关闭"
              onClick={onClose}
            >
              <X size={18} />
            </button>
          </div>
        </div>
        <img className="lightbox-image" src={src} alt={alt} />
      </div>
      <button
        type="button"
        className="lightbox-close"
        aria-label="关闭"
        title="关闭"
        onClick={onClose}
      >
        <X size={18} />
      </button>
    </div>
  );
}
