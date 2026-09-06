import React, { useRef } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "../i18n/I18nProvider";
import { rememberSearchDialogOpener, resolveSearchOpener } from "./searchFocus";

interface Props {
  open: boolean;
  title: string;
  onClose: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  children: React.ReactNode;
}

/** Shared search surface with modal focus ownership and room for a scrolling list. */
export function SearchDialog({ open, title, onClose, inputRef, children }: Props) {
  const { t } = useT();
  const openerRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]" />
        <Dialog.Content
          ref={contentRef}
          className="fixed left-1/2 top-[min(12vh,6rem)] z-50 flex max-h-[calc(88dvh-1rem)] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-border/80 bg-popover text-popover-foreground shadow-2xl"
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            openerRef.current = resolveSearchOpener(document.activeElement);
            if (contentRef.current) {
              rememberSearchDialogOpener(contentRef.current, openerRef.current);
            }
            event.preventDefault();
            inputRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            // A selected command may have moved focus into another surface.
            // Restore on dismissal without taking focus back from that destination.
            const active = document.activeElement;
            if (
              active === document.body ||
              active === null ||
              contentRef.current?.contains(active)
            ) {
              if (openerRef.current?.isConnected) openerRef.current.focus({ preventScroll: true });
            }
          }}
          onKeyDown={(event) => {
            // Keyboard input belongs to the modal; app-level session/panel
            // shortcuts must not mutate the background while it is open.
            event.stopPropagation();
          }}
          onEscapeKeyDown={(event) => {
            // Esc can cancel an IME candidate without dismissing the search.
            if (event.isComposing || event.keyCode === 229) event.preventDefault();
          }}
        >
          <div className="flex shrink-0 items-center justify-between gap-3 px-4 pb-1 pt-3">
            <Dialog.Title className="text-sm font-semibold">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 rounded-lg text-muted-foreground"
                aria-label={t("panels.common.close")}
              >
                <X className="size-4" aria-hidden />
              </Button>
            </Dialog.Close>
          </div>
          {children}
          <div className="shrink-0 border-t border-border/70 bg-muted/25 px-4 py-2.5 text-[11px] text-muted-foreground">
            {t("panels.search.keyboardHint")}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
