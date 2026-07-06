import React, { memo } from "react";
import type { ContextBoundaryMessage } from "../types";
import { compactBoundaryDetail } from "../chat/compactFeedback";
import { useT } from "../i18n/I18nProvider";

function ContextBoundaryViewImpl({ message }: { message: ContextBoundaryMessage }) {
  const { t, lang } = useT();
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 px-4 py-2 text-center text-xs text-muted-foreground">
      <span>— {t("chat.compact.boundaryTitle")} —</span>
      <span>{compactBoundaryDetail(message, t, lang)}</span>
    </div>
  );
}

// Memoized — see Markdown / ToolCard for the rationale.
export const ContextBoundaryView = memo(ContextBoundaryViewImpl);
