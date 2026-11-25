import React, { Suspense } from "react";
import { useT } from "../i18n/I18nProvider";
import { LazyFileCodeView } from "./lazy";
import type { FileCodeViewProps } from "./pierreViews";

/**
 * Continuous, virtualized file view (Codex parity). Pierre renders only the
 * rows near the viewport, highlights in its worker pool and owns cmd/ctrl+F
 * search across the whole file. It loads on first use.
 */
export function FileCodeView(props: FileCodeViewProps) {
  const { t } = useT();
  return (
    <Suspense
      fallback={
        <div className="p-4 text-sm text-muted-foreground" data-file-code-view-loading>
          {t("panels.common.loading")}
        </div>
      }
    >
      <LazyFileCodeView {...props} />
    </Suspense>
  );
}
