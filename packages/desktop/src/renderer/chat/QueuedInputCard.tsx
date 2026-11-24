import React from "react";
import { CornerDownRight, FileText, Folder, Paperclip, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn, formatBytes } from "@/lib/utils";
import { useT } from "../i18n/I18nProvider";
import { decodeWireForDisplay } from "./attachments";
import type { LightboxItem } from "./Lightbox";
import { useAttachmentDataUrl, type DisplayAttachment } from "./useAttachmentDataUrl";

/** One queued follow-up as the waiting panel shows it. */
export interface QueuedInputPreview {
  text: string;
  attachments?: readonly DisplayAttachment[];
}

interface Props {
  items: readonly (string | QueuedInputPreview)[];
  busy: boolean;
  onGuide?: () => void;
  onClear?: () => void;
  onRemove?: (index: number) => void;
  onZoom: (items: LightboxItem[], index: number) => void;
}

const MAX_PREVIEW_CHARS = 180;

/** Text, inline images and saved attachments of one queued item, ready to render. */
function previewOf(item: string | QueuedInputPreview) {
  const raw = typeof item === "string" ? item : item.text;
  const decoded = decodeWireForDisplay(raw);
  const text =
    decoded.text.length > MAX_PREVIEW_CHARS
      ? `${decoded.text.slice(0, MAX_PREVIEW_CHARS)}...`
      : decoded.text;
  return {
    text,
    inlineImages: decoded.images,
    attachments: typeof item === "string" ? [] : (item.attachments ?? []),
  };
}

export function QueuedInputCard({ items, busy, onGuide, onClear, onRemove, onZoom }: Props) {
  const { t } = useT();
  if (items.length === 0) return null;
  return (
    <div
      className="mb-2 rounded-2xl border border-border/80 bg-background/80 px-3 py-2 shadow-sm"
      data-queued-input-card
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-muted-foreground">
          <CornerDownRight size={14} />
          <span>{t("chat.queue.heading")}</span>
          <span className="text-xs font-normal tabular-nums">{items.length}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {busy && onGuide && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 gap-1 rounded-full px-2 text-xs text-muted-foreground"
              aria-label={t("chat.queue.guideAllAria")}
              title={t("chat.queue.guideAllTitle")}
              onClick={onGuide}
            >
              <CornerDownRight size={12} />
              <span>{t("chat.queue.guideAll")}</span>
            </Button>
          )}
          {onClear && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6 rounded-full text-muted-foreground"
              aria-label={t("chat.queue.clearAria")}
              title={t("chat.queue.clearTitle")}
              onClick={onClear}
            >
              <Trash2 size={14} />
            </Button>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-1">
        {items.map((item, i) => {
          const preview = previewOf(item);
          const hasAttachments = preview.attachments.length > 0 || preview.inlineImages.length > 0;
          return (
            <div
              key={i}
              className="group/queued flex min-w-0 items-start gap-2 rounded-xl border border-border/70 bg-muted/30 px-3 py-2 text-sm text-foreground"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                {preview.text && (
                  <div className="line-clamp-2 min-w-0 whitespace-pre-wrap break-words">
                    {preview.text}
                  </div>
                )}
                {hasAttachments && (
                  <div className="flex min-w-0 flex-wrap gap-1.5" data-queued-attachments>
                    {preview.inlineImages.map((image, index) => (
                      <InlineImageThumb
                        key={`inline-${index}`}
                        src={image.dataUrl}
                        name={image.name}
                        onZoom={() =>
                          onZoom(
                            preview.inlineImages.map((g) => ({
                              src: g.dataUrl,
                              alt: g.name || "image",
                              name: g.name || undefined,
                            })),
                            index,
                          )
                        }
                      />
                    ))}
                    {preview.attachments.map((attachment, index) => (
                      <SavedAttachmentChip
                        key={`saved-${index}`}
                        attachment={attachment}
                        onZoom={onZoom}
                      />
                    ))}
                  </div>
                )}
                {hasAttachments && busy && (
                  <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <Paperclip size={11} aria-hidden="true" />
                    {t("chat.queue.attachmentsDeferredHint")}
                  </span>
                )}
              </div>
              {onRemove && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-6 shrink-0 rounded-full text-muted-foreground hover:bg-background"
                  aria-label={t("chat.queue.removeItemAria", { index: i + 1 })}
                  title={t("chat.queue.removeItemTitle")}
                  onClick={() => onRemove(i)}
                >
                  <Trash2 size={12} />
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const thumbClass =
  "flex h-10 max-w-[200px] shrink-0 items-center gap-2 overflow-hidden rounded-md border border-border/70 bg-background/70 pr-2 text-xs";

function InlineImageThumb({
  src,
  name,
  onZoom,
}: {
  src: string;
  name?: string;
  onZoom: () => void;
}) {
  const { t } = useT();
  const label = name || t("chat.composer.imageFallbackName");
  return (
    <button
      type="button"
      className={cn(
        thumbClass,
        "cursor-zoom-in outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
      aria-label={t("chat.composer.imageClickToZoom", { name: label })}
      title={label}
      onClick={onZoom}
    >
      <img src={src} alt={label} className="h-full w-10 shrink-0 object-cover" />
      <span className="truncate text-foreground">{label}</span>
    </button>
  );
}

function SavedAttachmentChip({
  attachment,
  onZoom,
}: {
  attachment: DisplayAttachment;
  onZoom: Props["onZoom"];
}) {
  const { t } = useT();
  const src = useAttachmentDataUrl(attachment);
  const fallbackName =
    attachment.kind === "image" ? t("chat.composer.imageFallbackName") : attachment.absPath;
  const name = attachment.originalName || fallbackName.split(/[\\/]/u).pop() || fallbackName;
  const meta = attachment.size ? formatBytes(attachment.size) : undefined;
  if (src)
    return (
      <InlineImageThumb
        src={src}
        name={name}
        onZoom={() => onZoom([{ src, alt: name, name }], 0)}
      />
    );
  const Icon = attachment.kind === "directory" ? Folder : FileText;
  return (
    <span className={cn(thumbClass, "pl-2")} title={attachment.absPath}>
      <Icon size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-foreground">{name}</span>
        {meta && <span className="text-[10px] tabular-nums text-muted-foreground">{meta}</span>}
      </span>
    </span>
  );
}
