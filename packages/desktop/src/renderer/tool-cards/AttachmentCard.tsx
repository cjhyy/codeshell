import React, { memo, useEffect, useState } from "react";
import { FileText, FileCode2, ImageIcon, File as FileIcon, MoreHorizontal } from "lucide-react";
import { truncate } from "./utils";
import type { Attachment } from "./attachments";
import { OpenWithMenu } from "../chat/OpenWithMenu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useT } from "../i18n/I18nProvider";

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
  const { t } = useT();
  const { path, kind } = attachment;
  const filename = path.split("/").pop() ?? path;
  const ext = (filename.split(".").pop() ?? "").toLowerCase();

  return (
    <span className="relative inline-flex items-center">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={cn(
          "h-auto max-w-[240px] justify-start gap-2 rounded-md px-2 py-1.5 pr-7 text-left",
          kind === "image" && "min-h-12",
        )}
        onClick={() => {
          void window.codeshell.openPath(path, cwd ?? undefined);
        }}
        title={path}
      >
        {kind === "image" ? (
          <ImageThumb path={path} cwd={cwd} />
        ) : (
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
            {iconFor(kind)}
          </span>
        )}
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-xs font-medium text-foreground">
            {truncate(filename, 48)}
          </span>
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">.{ext}</span>
        </span>
      </Button>
      <OpenWithMenu path={path} cwd={cwd} align="start">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          title={t("msg.tool.openWith")}
          aria-label={t("msg.tool.openWith")}
        >
          <MoreHorizontal size={14} />
        </Button>
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
function ImageThumb({ path, cwd }: { path: string; cwd?: string | null }) {
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
    void window.codeshell.readImageDataUrl(abs, { cwd: cwd ?? undefined }).then((dataUrl) => {
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
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
        <ImageIcon size={14} />
      </span>
    );
  }
  return (
    <img
      className="h-10 w-10 shrink-0 rounded object-cover"
      src={src}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
