import React, { memo, useEffect, useState } from "react";
import {
  FileText,
  FileCode2,
  ImageIcon,
  File as FileIcon,
  MoreHorizontal,
} from "lucide-react";
import { truncate } from "./utils";
import type { Attachment } from "./attachments";
import { OpenWithMenu } from "../chat/OpenWithMenu";

interface Props {
  attachment: Attachment;
  /**
   * Optional cwd used by openPath() to resolve relative paths. Most
   * built-in tools (GenerateImage, Write) emit absolute paths, in
   * which case this can be omitted.
   */
  cwd?: string | null;
}

/**
 * One-line attachment row: icon (or image thumbnail) + filename +
 * extension chip. Click opens the file in the OS default app via
 * shell:openPath; a hover "⋯" trigger opens the shared "open with" menu
 * (system default / editor / reveal in folder — TODO 2.2/2.3).
 *
 * Images: we read the file via the renderer's fetch("file://…")
 * gate, which the main process allows for absolute paths inside
 * the workspace via the file-search service. Falls back to a
 * generic icon if the read fails.
 */
function AttachmentCardImpl({ attachment, cwd }: Props) {
  const { path, kind } = attachment;
  const filename = path.split("/").pop() ?? path;
  const ext = (filename.split(".").pop() ?? "").toLowerCase();

  return (
    <span className="attachment-card-wrap">
      <button
        type="button"
        className={`attachment-card attachment-${kind}`}
        onClick={() => {
          void window.codeshell.openPath(path, cwd ?? undefined);
        }}
        title={path}
      >
        {kind === "image" ? (
          <ImageThumb path={path} cwd={cwd} />
        ) : (
          <span className="attachment-icon">{iconFor(kind)}</span>
        )}
        <span className="attachment-meta">
          <span className="attachment-name">{truncate(filename, 48)}</span>
          <span className="attachment-ext">.{ext}</span>
        </span>
      </button>
      <OpenWithMenu path={path} cwd={cwd} align="start">
        <button
          type="button"
          className="attachment-openwith"
          title="打开方式"
          aria-label="打开方式"
        >
          <MoreHorizontal size={14} />
        </button>
      </OpenWithMenu>
    </span>
  );
}

export const AttachmentCard = memo(AttachmentCardImpl);

function iconFor(kind: Attachment["kind"]) {
  const sz = 14;
  switch (kind) {
    case "image":
      return <ImageIcon size={sz} />;
    case "markdown":
      return <FileText size={sz} />;
    case "html":
      return <FileCode2 size={sz} />;
    default:
      return <FileIcon size={sz} />;
  }
}

/**
 * Render a 48×48 thumbnail for image attachments. We load via the
 * `file://<abs>` URL — Electron's renderer allows that within the
 * application's webSecurity-relaxed context. If the path is relative
 * we don't have cwd → just fall back to the icon variant.
 */
function ImageThumb({
  path,
  cwd,
}: {
  path: string;
  cwd?: string | null;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setSrc(null);
    const isAbs = path.startsWith("/");
    if (!isAbs && !cwd) {
      setFailed(true);
      return () => {
        cancelled = true;
      };
    }
    const abs = isAbs ? path : `${cwd!.replace(/\/$/, "")}/${path}`;
    // Load via the images:readDataUrl IPC, not `file://` — the renderer can't
    // load file:// (webSecurity + CSP block it); main returns a base64 data:
    // URL the CSP's `img-src ... data:` allows.
    void window.codeshell.readImageDataUrl(abs).then((dataUrl) => {
      if (cancelled) return;
      if (dataUrl) setSrc(dataUrl);
      else setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [path, cwd]);

  if (failed || !src) {
    return (
      <span className="attachment-icon">
        <ImageIcon size={14} />
      </span>
    );
  }
  return (
    <img
      className="attachment-thumb"
      src={src}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
