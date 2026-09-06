import React, { useEffect, useRef } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "../i18n/I18nProvider";

export const SIDEBAR_NAVIGATION_ID = "codeshell-sidebar-navigation";

interface Props {
  narrow: boolean;
  open: boolean;
  onClose: () => void;
  onAfterClose: () => void;
  toggleRef: React.RefObject<HTMLButtonElement | null>;
  children: React.ReactNode;
}

export function ResponsiveSidebar({
  narrow,
  open,
  onClose,
  onAfterClose,
  toggleRef,
  children,
}: Props) {
  const { t } = useT();
  const contentRef = useRef<HTMLDivElement>(null);
  const desktopHadFocus = useRef(false);
  useEffect(() => {
    if (narrow && desktopHadFocus.current && document.activeElement === document.body) {
      toggleRef.current?.focus({ preventScroll: true });
    }
    desktopHadFocus.current = false;
  }, [narrow, toggleRef]);

  if (!narrow) {
    return open ? (
      <div
        id={SIDEBAR_NAVIGATION_ID}
        className="flex shrink-0 overflow-hidden"
        onFocusCapture={() => {
          desktopHadFocus.current = true;
        }}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) desktopHadFocus.current = false;
        }}
      >
        {children}
      </div>
    ) : null;
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-x-0 bottom-0 top-11 z-40 bg-black/35" />
        <Dialog.Content
          ref={contentRef}
          id={SIDEBAR_NAVIGATION_ID}
          aria-modal="true"
          aria-describedby={undefined}
          className="fixed bottom-0 left-0 top-11 z-40 flex w-60 max-w-[calc(100vw-2rem)] flex-col border-r border-border bg-background shadow-xl outline-none"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const active = document.activeElement;
            if (
              active === document.body ||
              active === null ||
              contentRef.current?.contains(active)
            ) {
              if (toggleRef.current?.isConnected) toggleRef.current.focus({ preventScroll: true });
            }
            // Opening search after returning to the persistent trigger gives
            // the new dialog a valid opener and avoids competing focus scopes.
            onAfterClose();
          }}
          onEscapeKeyDown={(event) => {
            if (
              event.isComposing ||
              event.keyCode === 229 ||
              contentRef.current?.querySelector('[role="menu"]')
            ) {
              event.preventDefault();
            }
          }}
          onKeyDown={(event) => {
            if (!contentRef.current?.contains(event.target as Node)) return;
            // These existing menus own their document-level Escape listener.
            if (event.key === "Escape" && contentRef.current.querySelector('[role="menu"]')) return;
            const mod = event.metaKey || event.ctrlKey;
            // App routes global search and session selection through the same
            // close-then-navigate handoff as clicking a navigation item.
            if (mod && /^(k|p|f|[1-9])$/i.test(event.key)) return;
            event.stopPropagation();
            if (
              mod &&
              event.key.toLowerCase() === "b" &&
              !event.nativeEvent.isComposing &&
              event.keyCode !== 229
            ) {
              event.preventDefault();
              onClose();
            }
          }}
        >
          <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border/70 px-3">
            <Dialog.Title className="text-xs font-semibold text-muted-foreground">
              {t("sidebar.navigation")}
            </Dialog.Title>
            <Dialog.Close asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 rounded-lg"
                aria-label={t("topbar.collapseSidebar")}
              >
                <X className="size-4" aria-hidden />
              </Button>
            </Dialog.Close>
          </div>
          <div className="flex min-h-0 flex-1">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
