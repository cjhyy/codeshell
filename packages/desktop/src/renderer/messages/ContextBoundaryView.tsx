import React, { memo } from "react";
import { Archive } from "lucide-react";
import type { ContextBoundaryMessage } from "../types";
import { compactBoundaryDetail } from "../chat/compactFeedback";
import { useT } from "../i18n/I18nProvider";

function ContextBoundaryViewImpl({ message }: { message: ContextBoundaryMessage }) {
  const { t, lang } = useT();
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
