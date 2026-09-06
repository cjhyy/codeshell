import React, { useCallback, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, Download, Copy, FolderOpen, Check, ChevronLeft, ChevronRight } from "lucide-react";
import { useToast } from "../ui/ToastProvider";
import { Button } from "@/components/ui/button";
import { useT } from "../i18n/I18nProvider";
import { useCopyFeedback } from "../ui/useCopyFeedback";

/** Pure decision so the close behavior is unit-testable without a DOM. */
export function shouldCloseOnKey(key: string): boolean {
  return key === "Escape";
}

/**
 * Map an arrow key to a navigation delta within a gallery, or 0 if the key
 * isn't a navigation key. Pure so it's unit-testable without a DOM.
 */
export function navDeltaForKey(key: string): -1 | 0 | 1 {
  if (key === "ArrowLeft") return -1;
  if (key === "ArrowRight") return 1;
  return 0;
}

/**
 * Wrap-around index step over a gallery of `count` items. Stepping past the end
 * loops to the start and vice-versa, so left/right are always live with >1
 * image. Returns `current` unchanged when there's nothing to navigate.
 */
export function stepIndex(current: number, delta: number, count: number): number {
  if (count <= 1) return current;
  return (current + delta + count) % count;
}

/** One image in a Lightbox gallery. */
export interface LightboxItem {
  /** Display source — a `data:` URL (so it renders under the CSP). */
  src: string;
  alt: string;
  /** On-disk path when file-backed; absent for pasted/dragged attachments. */
  path?: string | null;
  /** Suggested download filename. */
  name?: string | null;
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
  /**
   * Optional gallery the opened image belongs to (e.g. the sibling images in
   * one pasted message). When present and length > 1, prev/next controls and
   * Left/Right arrow keys cycle through them. The `src`/`alt`/`path`/`name`
   * props are ignored in favour of `items[index]`.
   */
  items?: LightboxItem[];
  /** Index of the currently-shown item within `items`. */
  index?: number;
}

/**
 * Full-screen image viewer. Click the backdrop or press Escape to close.
 * Toolbar offers download (always, via the data URL), and — when the image is
 * file-backed — copy path / reveal in folder. When opened with a multi-image
 * `items` gallery, Left/Right arrows and on-screen chevrons cycle through it.
 */
export function Lightbox({ src, alt, onClose, path, cwd, name, items, index }: LightboxProps) {
  const { t } = useT();
  const toast = useToast();
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  // Resolve the gallery: either the explicit `items` array, or a singleton
  // built from the legacy single-image props. `cur` is the active index.
  const gallery: LightboxItem[] = items && items.length > 0 ? items : [{ src, alt, path, name }];
  const [cur, setCur] = useState(index ?? 0);
  const safeCur = Math.min(Math.max(cur, 0), gallery.length - 1);
  const active = gallery[safeCur]!;
  const hasNav = gallery.length > 1;
  const { copied, copy } = useCopyFeedback(active.path ?? safeCur);

  const navigate = useCallback(
    (delta: number) => setCur((c) => stepIndex(c, delta, gallery.length)),
    [gallery.length],
  );

  const filename =
    active.name?.trim() ||
    (active.path ? active.path.split(/[\\/]/).pop() : null) ||
    active.alt?.trim() ||
    t("chat.composer.imageFallbackName");
  const imageLabel = active.alt?.trim() || filename;

  const onDownload = (): void => {
    void window.codeshell.saveImage(active.src, { name: filename }).then(
      (saved) => {
        // saveImage resolves to the saved path (or null/undefined if the user
        // cancelled the save dialog) — only confirm on a real save.
        if (saved) toast({ message: t("chat.lightbox.imageSaved"), variant: "success" });
      },
      () => toast({ message: t("chat.lightbox.saveFailed"), variant: "error" }),
    );
  };
  const onCopyPath = async (): Promise<void> => {
    if (!active.path) return;
    const success = await copy(active.path);
    toast({
      message: t(success ? "chat.lightbox.pathCopied" : "msg.copyFailed"),
      variant: success ? "success" : "error",
    });
  };
  const onReveal = (): void => {
    const p = active.path;
    if (!p) return;
    void window.codeshell.openPath(p, cwd ?? undefined).then((abs) => {
      // openPath resolves the abs path; reveal that so we land on the file.
      void window.codeshell.revealInFinder(abs ?? p);
    });
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal container={typeof document === "undefined" ? undefined : document.body}>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/80" />
        <Dialog.Content
          className="fixed inset-4 z-50 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-white/10 bg-background/95 shadow-2xl backdrop-blur"
          aria-modal="true"
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            // These viewers open from buttons outside the Dialog tree, so
            // Radix has no Trigger ref to restore. Remember the actual opener.
            openerRef.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
            event.preventDefault();
            closeRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            openerRef.current?.focus({ preventScroll: true });
          }}
          onKeyDown={(event) => {
            // Keep app-global session/palette shortcuts behind this modal.
            // Native selection/copy still work; only propagation is stopped.
            event.stopPropagation();
            const delta = navDeltaForKey(event.key);
            if (delta !== 0 && hasNav) {
              event.preventDefault();
              navigate(delta);
            }
          }}
        >
          <div className="flex shrink-0 items-center gap-3 border-b border-border/70 bg-card/90 px-3 py-2">
            <Dialog.Title
              className="min-w-0 flex-1 truncate text-sm font-medium"
              title={active.path ?? imageLabel}
            >
              {imageLabel}
              {hasNav && (
                <span
                  className="ml-2 text-xs text-muted-foreground"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {safeCur + 1}/{gallery.length}
                </span>
              )}
            </Dialog.Title>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={t("chat.lightbox.download")}
                title={t("chat.lightbox.download")}
                onClick={onDownload}
              >
                <Download size={16} />
              </Button>
              {active.path && (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={t("chat.lightbox.copyPath")}
                  title={copied ? t("chat.lightbox.copied") : t("chat.lightbox.copyPath")}
                  onClick={onCopyPath}
                >
                  {copied ? <Check size={16} /> : <Copy size={16} />}
                </Button>
              )}
              {active.path && (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={t("chat.lightbox.reveal")}
                  title={t("chat.lightbox.reveal")}
                  onClick={onReveal}
                >
                  <FolderOpen size={16} />
                </Button>
              )}
              <Dialog.Close asChild>
                <Button
                  ref={closeRef}
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={t("chat.lightbox.close")}
                  title={t("chat.lightbox.close")}
                >
                  <X size={18} />
                </Button>
              </Dialog.Close>
            </div>
          </div>
          {hasNav && (
            <Button
              type="button"
              className="absolute left-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-background/80 shadow-lg"
              size="icon"
              variant="outline"
              aria-label={t("chat.lightbox.prev")}
              title={t("chat.lightbox.prev")}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => navigate(-1)}
            >
              <ChevronLeft size={28} />
            </Button>
          )}
          <div className="flex min-h-0 flex-1 items-center justify-center bg-black/40 p-4">
            <img
              className="max-h-full max-w-full object-contain"
              src={active.src}
              alt={imageLabel}
            />
          </div>
          {hasNav && (
            <Button
              type="button"
              className="absolute right-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-background/80 shadow-lg"
              size="icon"
              variant="outline"
              aria-label={t("chat.lightbox.next")}
              title={t("chat.lightbox.next")}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => navigate(1)}
            >
              <ChevronRight size={28} />
            </Button>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
