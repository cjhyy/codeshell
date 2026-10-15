import React, { useLayoutEffect, useRef } from "react";
import type { McpProbeResult } from "../../preload/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useT } from "../i18n/I18nProvider";

interface DetailProps {
  probe: McpProbeResult;
  opener: HTMLButtonElement | null;
  onClose: () => void;
}

function McpDetailDialog({
  title,
  opener,
  onClose,
  children,
}: Omit<DetailProps, "probe"> & { title: string; children: React.ReactNode }) {
  const { t } = useT();
  const closeRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const ownsReturnFocus = useRef(true);
  useLayoutEffect(() => {
    const cancelReturn = () => {
      ownsReturnFocus.current = false;
    };
    const onFocus = (event: FocusEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target !== document.body &&
        !target.hasAttribute("data-radix-focus-guard") &&
        !contentRef.current?.contains(target)
      ) {
        cancelReturn();
      }
    };
    const onPointer = (event: PointerEvent) => {
      const content = contentRef.current;
      // DialogContent renders its overlay immediately before the content. An
      // overlay dismissal returns to the opener; another surface owns its click.
      if (
        event.target !== content?.previousElementSibling &&
        !content?.contains(event.target as Node)
      ) {
        cancelReturn();
      }
    };
    document.addEventListener("focusin", onFocus, true);
    document.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("blur", cancelReturn);
    return () => {
      document.removeEventListener("focusin", onFocus, true);
      document.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("blur", cancelReturn);
    };
  }, []);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        ref={contentRef}
        showClose={false}
        aria-describedby={undefined}
        className="flex min-h-0 max-w-2xl flex-col gap-3 overflow-hidden p-4"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          closeRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const focused = document.activeElement;
          if (
            ownsReturnFocus.current &&
            opener?.isConnected &&
            !opener.disabled &&
            (!focused || focused === document.body || !focused.isConnected)
          ) {
            opener.focus();
          }
        }}
      >
        <header className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
          <DialogTitle
            tabIndex={0}
            className="max-h-[25dvh] min-w-0 overflow-y-auto overscroll-contain text-sm leading-5 [overflow-wrap:anywhere]"
          >
            {title}
          </DialogTitle>
          <Button ref={closeRef} type="button" variant="ghost" size="sm" onClick={onClose}>
            {t("settingsX.mcp.close")}
          </Button>
        </header>
        <div
          role="region"
          aria-label={title}
          tabIndex={0}
          className="min-h-0 min-w-0 overflow-y-auto overscroll-contain [overflow-wrap:anywhere]"
        >
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ToolsViewer({ probe, ...dialog }: DetailProps) {
  const { t } = useT();
  return (
    <McpDetailDialog
      {...dialog}
      title={t("settingsX.mcp.toolsHeader", { name: probe.name, count: probe.tools?.length ?? 0 })}
    >
      {probe.tools && probe.tools.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {probe.tools.map((tool) => (
            <li key={tool.name} className="min-w-0 rounded-md border p-2">
              <code className="font-mono text-xs text-foreground">{tool.name}</code>
              {tool.description && (
                <span className="mt-1 block text-xs text-muted-foreground">{tool.description}</span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div className="p-4 text-center text-sm text-muted-foreground">
          {t("settingsX.mcp.noToolReturned")}
        </div>
      )}
    </McpDetailDialog>
  );
}

export function ErrorDetailViewer({ probe, ...dialog }: DetailProps) {
  const { t } = useT();
  return (
    <McpDetailDialog {...dialog} title={t("settingsX.mcp.errorDetailHeader", { name: probe.name })}>
      <div className="rounded-md bg-status-err/10 p-2 text-sm text-status-err">
        {probe.errorMessage}
      </div>
      <pre
        tabIndex={0}
        className="mt-2 max-h-[min(24rem,30dvh)] max-w-full overflow-auto overscroll-contain rounded-md bg-muted/40 p-3 font-mono text-xs"
      >
        {probe.errorDetail}
      </pre>
    </McpDetailDialog>
  );
}
