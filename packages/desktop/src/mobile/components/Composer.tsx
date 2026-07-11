import { useEffect, useRef, useState } from "react";
import { Camera, Images, SendHorizonal, Square, X } from "lucide-react";
import { Button } from "@ui/button";
import { useT } from "@/i18n";
import {
  MOBILE_MAX_ATTACHMENTS,
  type MobileComposerAttachment,
} from "@mobile/lib/mobileAttachments";

interface DraftAttachment extends MobileComposerAttachment {
  previewUrl: string;
}

function nextClientId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `image-${Date.now()}-${Math.random()}`;
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Bottom input bar: autosizing textarea, image drafts, send, and stop. */
export function Composer({
  disabled,
  running,
  onSend,
  onStop,
}: {
  disabled: boolean;
  running: boolean;
  onSend: (input: { text: string; attachments: MobileComposerAttachment[] }) => Promise<boolean>;
  onStop: () => void;
}) {
  const { t } = useT();
  const ref = useRef<HTMLTextAreaElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const previewUrlsRef = useRef(new Set<string>());
  // React state does not update until the next render, so two taps in the same
  // frame can both see pending=false. This ref closes that tiny upload window.
  const submitInFlightRef = useRef(false);
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [pending, setPending] = useState(false);
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!queued) return;
    if (running) {
      setQueued(false);
      return;
    }
    const timer = setTimeout(() => setQueued(false), 5000);
    return () => clearTimeout(timer);
  }, [queued, running]);

  useEffect(
    () => () => {
      for (const url of previewUrlsRef.current) URL.revokeObjectURL(url);
      previewUrlsRef.current.clear();
    },
    [],
  );

  const autosize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  };

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    setError(null);
    setAttachments((current) => {
      const room = MOBILE_MAX_ATTACHMENTS - current.length;
      if (files.length > room) setError(t("mobile.composer.tooManyImages"));
      const next = [...current];
      for (const file of Array.from(files).slice(0, Math.max(0, room))) {
        // Some mobile pickers (notably HEIC on older iOS versions) omit MIME;
        // let the normalization step attempt a real browser decode in that case.
        if (file.type && !file.type.startsWith("image/")) {
          setError(t("mobile.composer.unsupportedImage"));
          continue;
        }
        const previewUrl = URL.createObjectURL(file);
        previewUrlsRef.current.add(previewUrl);
        next.push({ clientId: nextClientId(), file, previewUrl });
      }
      return next;
    });
  };

  const removeAttachment = (clientId: string) => {
    setAttachments((current) => {
      const removed = current.find((item) => item.clientId === clientId);
      if (removed) {
        URL.revokeObjectURL(removed.previewUrl);
        previewUrlsRef.current.delete(removed.previewUrl);
      }
      return current.filter((item) => item.clientId !== clientId);
    });
  };

  const submit = async () => {
    if (submitInFlightRef.current || pending || queued) return;
    const el = ref.current;
    if (!el) return;
    const text = el.value.trim();
    if (!text && attachments.length === 0) return;
    submitInFlightRef.current = true;
    setPending(true);
    setError(null);
    try {
      const sent = await onSend({
        text,
        attachments: attachments.map(({ clientId, file }) => ({ clientId, file })),
      });
      if (!sent) {
        setError(t("mobile.composer.sendFailed"));
        return;
      }
      setQueued(true);
      for (const attachment of attachments) {
        URL.revokeObjectURL(attachment.previewUrl);
        previewUrlsRef.current.delete(attachment.previewUrl);
      }
      setAttachments([]);
      el.value = "";
      autosize();
    } catch {
      // Keep both text and image drafts intact so a transient socket/upload
      // failure can be retried without re-selecting anything.
      setError(t("mobile.composer.sendFailed"));
    } finally {
      submitInFlightRef.current = false;
      setPending(false);
    }
  };

  const inputDisabled = disabled || pending || queued || running;

  return (
    <div className="mobile-compose mobile-safe-bottom flex flex-col gap-2 p-2.5">
      {attachments.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-0.5">
          {attachments.map((attachment) => (
            <div
              key={attachment.clientId}
              className="relative flex w-40 shrink-0 items-center gap-2 rounded-lg border border-border/70 bg-muted/35 p-1.5"
            >
              <img
                src={attachment.previewUrl}
                alt={attachment.file.name}
                className="size-11 shrink-0 rounded object-cover"
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs">{attachment.file.name}</div>
                <div className="text-[10px] text-muted-foreground">
                  {formatSize(attachment.file.size)}
                </div>
              </div>
              <button
                type="button"
                disabled={pending}
                aria-label={t("mobile.composer.removeImage")}
                className="absolute right-0.5 top-0.5 rounded-full bg-black/65 p-0.5 text-white"
                onClick={() => removeAttachment(attachment.clientId)}
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      {error && <div className="text-xs text-status-err">{error}</div>}
      <div className="flex items-end gap-2">
        <input
          ref={galleryRef}
          hidden
          type="file"
          accept="image/*"
          multiple
          onChange={(event) => {
            addFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <input
          ref={cameraRef}
          hidden
          type="file"
          accept="image/*"
          capture="environment"
          onChange={(event) => {
            addFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-[46px] w-[46px] shrink-0 rounded-xl"
          disabled={inputDisabled || attachments.length >= MOBILE_MAX_ATTACHMENTS}
          aria-label={t("mobile.composer.chooseImages")}
          onClick={() => galleryRef.current?.click()}
        >
          <Images />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-[46px] w-[46px] shrink-0 rounded-xl"
          disabled={inputDisabled || attachments.length >= MOBILE_MAX_ATTACHMENTS}
          aria-label={t("mobile.composer.takePhoto")}
          onClick={() => cameraRef.current?.click()}
        >
          <Camera />
        </Button>
        <textarea
          ref={ref}
          rows={1}
          disabled={disabled || pending || queued}
          onInput={autosize}
          name="codeshell-prompt"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          data-1p-ignore="true"
          data-lpignore="true"
          enterKeyHint="enter"
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              window.matchMedia("(min-width: 820px)").matches
            ) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={
            disabled ? t("mobile.composer.disconnected") : t("mobile.composer.placeholder")
          }
          className="mobile-compose-input max-h-40 min-h-[46px] min-w-0 flex-1 resize-none rounded-xl border px-3.5 py-2.5 text-base leading-6 text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-50"
        />
        {running ? (
          <Button variant="outline" className="h-[46px] shrink-0 rounded-xl px-3" onClick={onStop}>
            <Square />
            {t("mobile.composer.stop")}
          </Button>
        ) : (
          <Button
            className="h-[46px] shrink-0 rounded-xl px-3"
            disabled={disabled || pending || queued}
            onClick={() => void submit()}
          >
            <SendHorizonal />
            {pending ? t("mobile.composer.uploading") : t("mobile.composer.send")}
          </Button>
        )}
      </div>
    </div>
  );
}
