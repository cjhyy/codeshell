import React, { memo, useEffect, useState } from "react";
import { FileText, FileCode2, ImageIcon, File as FileIcon, MoreHorizontal } from "lucide-react";
import { truncate } from "./utils";
import type { Attachment, AttachmentContext } from "./attachments";
import { InlineMedia } from "../chat/InlineMedia";
import { OpenWithMenu } from "../chat/OpenWithMenu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useT } from "../i18n/I18nProvider";

interface Props extends AttachmentContext {
  attachment: Attachment;
}

/**
 * Audio/video attachments use the task-authorized inline player. Other files
 * retain the compact icon/thumbnail row and shared "open with" menu.
 *
 * Image thumbnails use Main's readImageDataUrl bridge and fall back to an icon
 * when the file cannot be read.
 */
function AttachmentCardImpl({ attachment, cwd, sessionId, sessionMainRootId, rootStatus }: Props) {
  const { t } = useT();
  const { path, kind } = attachment;
  const filename = path.split("/").pop() ?? path;
  const ext = (filename.split(".").pop() ?? "").toLowerCase();

  if (kind === "audio" || kind === "video") {
    return (
      <InlineMedia
        path={path}
        kind={kind}
        cwd={cwd}
        sessionId={sessionId}
        sessionMainRootId={sessionMainRootId}
        rootStatus={rootStatus}
        label={filename}
      />
    );
  }

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
 * Read a thumbnail through the image IPC bridge. Relative paths without a cwd
 * fall back to the icon variant.
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
