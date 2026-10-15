import React, { memo } from "react";
import { Archive, ChevronDown, Forward, Link2 } from "lucide-react";
import type { ContextBoundaryMessage } from "../types";
import { compactBoundaryDetail } from "../chat/compactFeedback";
import { useT } from "../i18n/I18nProvider";

function ContextBoundaryViewImpl({ message }: { message: ContextBoundaryMessage }) {
  const { t, lang } = useT();
  if (message.contextTransfer) {
    const transfer = message.contextTransfer;
    return (
      <details className="group/context-package mx-4 my-3 min-w-0 overflow-hidden rounded-2xl border border-border/70 bg-card/70 shadow-sm">
        <summary className="flex cursor-pointer list-none items-start gap-3 rounded-2xl px-4 py-3.5 outline-none transition-colors hover:bg-muted/25 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-primary/10 bg-primary/5 text-primary">
            <Forward size={17} aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-foreground">
              {t("chat.contextPackage.cardTitle")}
            </span>
            <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
              {t("chat.contextPackage.cardHint")}
            </span>
            <span className="mt-2 inline-flex rounded-md bg-muted/60 px-2 py-1 text-[11px] leading-4 tabular-nums text-muted-foreground">
              {t("chat.contextPackage.cardMeta", {
                tokens: transfer.estimatedTokens,
              })}
            </span>
          </span>
          <ChevronDown
            size={15}
            aria-hidden="true"
            className="mt-1 shrink-0 text-muted-foreground transition-transform group-open/context-package:rotate-180 motion-reduce:transition-none"
          />
        </summary>
        <div className="border-t border-border/60 px-4 pb-4 pt-3">
          <div className="mb-2 text-[11px] font-medium text-muted-foreground">
            {t("chat.contextPackage.summaryLabel")}
          </div>
          <div className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
            {transfer.summary}
          </div>
          <details className="group/context-source mt-4 rounded-xl border border-border/60 bg-muted/20">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2.5 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
              <Link2 size={13} aria-hidden="true" className="shrink-0" />
              <span className="min-w-0 flex-1">{t("chat.contextPackage.sourceDetails")}</span>
              <ChevronDown
                size={13}
                aria-hidden="true"
                className="shrink-0 transition-transform group-open/context-source:rotate-180 motion-reduce:transition-none"
              />
            </summary>
            <div className="border-t border-border/50 px-3 py-3">
              <p className="m-0 mb-3 text-[11px] text-muted-foreground">
                {t("chat.contextPackage.sourceEvents", { count: transfer.sourceEventCount })}
              </p>
              <dl className="space-y-3">
                <div>
                  <dt className="text-[11px] text-muted-foreground">
                    {t("chat.contextPackage.sourceSession")}
                  </dt>
                  <dd className="m-0 mt-1 break-all font-mono text-[11px] leading-5 text-foreground">
                    {transfer.sourceSessionId}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] text-muted-foreground">
                    {t("chat.contextPackage.sourceRange")}
                  </dt>
                  <dd className="m-0 mt-1 break-all font-mono text-[11px] leading-5 text-foreground">
                    {transfer.fromEventId} → {transfer.toEventId}
                  </dd>
                </div>
              </dl>
            </div>
          </details>
        </div>
      </details>
    );
  }
  return (
    <div className="my-3 flex items-center gap-3 px-4 text-xs text-muted-foreground">
      <div className="h-px min-w-6 flex-1 bg-border" />
      <div className="inline-flex max-w-full items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 shadow-sm">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">
          <Archive size={14} />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-foreground">
            {t("chat.compact.boundaryTitle")}
          </span>
          <span className="block truncate tabular-nums">
            {compactBoundaryDetail(message, t, lang)}
          </span>
        </span>
      </div>
      <div className="h-px min-w-6 flex-1 bg-border" />
    </div>
  );
}

// Memoized — see Markdown / ToolCard for the rationale.
export const ContextBoundaryView = memo(ContextBoundaryViewImpl);
