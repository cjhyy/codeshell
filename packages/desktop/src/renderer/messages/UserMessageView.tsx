import React, { memo } from "react";
import { extractAnnotations } from "../chat/anchors";
import { decodeWireForDisplay } from "../chat/attachments";
import type { LightboxItem } from "../chat/Lightbox";
import { isSystemReminderText } from "../contextSelection";
import { useT } from "../i18n/I18nProvider";
import type { UserMessage } from "../types";
import { AnnotationsBlock } from "./AnnotationsBlock";
import { CollapsibleContent } from "./CollapsibleContent";
import { SystemReminderTask } from "./SystemReminderTask";
import { formatMessageTime } from "./time";

interface Props {
  message: UserMessage;
  localRuntime: boolean;
  onZoom: (items: LightboxItem[], index: number) => void;
}

// Reuse settled bubbles across composer and scroll updates so CollapsibleContent
// only measures when its content or size changes.
export const UserMessageView = memo(function UserMessageView({
  message,
  localRuntime,
  onZoom,
}: Props) {
  const { t } = useT();
  if (isSystemReminderText(message.text)) {
    return <SystemReminderTask text={message.text} />;
  }
  const decoded = decodeWireForDisplay(message.text);
  const images = decoded.images;
  const { block: annotations, text } = extractAnnotations(decoded.text);
  const askedAt = formatMessageTime(message.createdAt);
  // A local optimistic send carries its images inline in the wire text;
  // a message restored from the output journal carries only the
  // attachment summary, which must still be shown.
  const remoteAttachments = localRuntime && images.length > 0 ? [] : (message.attachments ?? []);
  if (!text && !annotations && images.length === 0 && remoteAttachments.length === 0) return null;
  return (
    <div className="group flex min-w-0 max-w-full flex-col items-end px-4 py-1.5">
      {message.isGoal && (
        <span className="mb-0.5 flex items-center gap-1 px-1 text-[11px] font-medium text-status-running">
          ◎ {t("msg.user.goal")}
        </span>
      )}
      <div
        className={
          "min-w-0 max-w-[80%] rounded-xl border px-3 py-2 text-sm " +
          (message.isGoal
            ? "border-status-running/50 bg-status-running/10"
            : "border-border bg-muted/40")
        }
      >
        {annotations && <AnnotationsBlock block={annotations} />}
        {text && (
          <CollapsibleContent>
            <div className="whitespace-pre-wrap break-words">{text}</div>
          </CollapsibleContent>
        )}
        {remoteAttachments.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2" data-remote-message-attachments>
            {remoteAttachments.map((attachment, index) => (
              <span
                key={index}
                className="max-w-full break-words rounded-md border px-2 py-1 text-xs"
              >
                {attachment.originalName}
              </span>
            ))}
          </div>
        )}
        {images.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {images.map((img, i) => (
              <button
                key={i}
                type="button"
                className="max-w-full cursor-zoom-in overflow-hidden rounded-lg outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                aria-label={t("chat.composer.imageClickToZoom", {
                  name: img.name || t("chat.composer.imageFallbackName"),
                })}
                onClick={() =>
                  onZoom(
                    images.map((g) => ({
                      src: g.dataUrl,
                      alt: g.name || "image",
                      name: g.name || undefined,
                    })),
                    i,
                  )
                }
              >
                <img
                  className="h-20 max-w-full object-cover"
                  src={img.dataUrl}
                  alt={img.name || t("chat.composer.imageFallbackName")}
                  title={img.name || undefined}
                />
              </button>
            ))}
          </div>
        )}
      </div>
      {askedAt && (
        <span className="mt-0.5 px-1 text-[11px] tabular-nums text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
          {askedAt}
        </span>
      )}
    </div>
  );
});
