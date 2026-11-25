import React, { Suspense } from "react";
import { useT } from "../i18n/I18nProvider";
import { LazyFileCodeView } from "./lazy";
import { PierreBoundary, pierreSupported } from "./PierreBoundary";
import { PlainFileView } from "./PlainFileView";
import type { FileCodeViewProps } from "./pierreViews";

/**
 * Continuous, virtualized file view (Codex parity). Pierre renders only the
 * rows near the viewport, highlights in its worker pool and owns cmd/ctrl+F
 * search across the whole file. It loads on first use; where Pierre cannot
 * run, or fails, a plain line view keeps the file readable and commentable.
 */
export function FileCodeView(props: FileCodeViewProps) {
  const { t } = useT();
  const plain = <PlainFileView {...props} />;
  if (!pierreSupported()) return plain;
  return (
    <PierreBoundary fallback={plain}>
      <Suspense
        fallback={
          <div className="p-4 text-sm text-muted-foreground" data-file-code-view-loading>
            {t("panels.common.loading")}
          </div>
        }
      >
        <LazyFileCodeView {...props} />
      </Suspense>
    </PierreBoundary>
  );
}
