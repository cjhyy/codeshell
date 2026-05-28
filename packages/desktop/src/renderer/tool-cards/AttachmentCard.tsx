import React, { memo, useEffect, useState } from "react";
import { FileText, FileCode2, ImageIcon, File as FileIcon } from "lucide-react";
import { truncate } from "./utils";
import type { Attachment } from "./attachments";

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
 * shell:openPath; right-click could later reveal in Finder.
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
    const fileUrl = `file://${abs}`;
    // Set src; the <img> onError will flip `failed` if the load
    // fails. No need to fetch ourselves — that would double the work.
    if (!cancelled) setSrc(fileUrl);
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
