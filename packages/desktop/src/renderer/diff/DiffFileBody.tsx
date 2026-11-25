import React, { Suspense, memo } from "react";
import { cn } from "@/lib/utils";
import { useT } from "../i18n/I18nProvider";
import { pierreSupported } from "../code-view/PierreBoundary";
import { LazyPierreFileDiffBody } from "../code-view/lazy";
import type { DiffFile } from "./parseUnifiedDiff";
import type { DiffSection } from "./diffSections";

export type DiffStyle = "unified" | "split";

interface Props {
  section: DiffSection;
  /** Stable per-file identity; also keys Pierre's highlight cache. */
  cacheKey: string;
  title: string;
  repoRoot: string;
  showRepository: boolean;
  commentable: boolean;
  diffStyle: DiffStyle;
}

/**
 * One file's changes. Pierre renders them inside the surrounding Virtualizer;
 * the plain patch shows while Pierre loads, and wherever it is unavailable.
 */
export const DiffFileBody = memo(function DiffFileBody(props: Props) {
  const { t } = useT();
  if (props.section.file.hunks.length === 0)
    return (
      <div className="px-3 py-2 text-xs text-muted-foreground" data-diff-no-text>
        {t("panels.diff.noTextChanges")}
      </div>
    );
  const fallback = <PlainDiffBody file={props.section.file} />;
  if (!pierreSupported()) return fallback;
  return (
    <Suspense fallback={fallback}>
      <LazyPierreFileDiffBody {...props} fallback={fallback} />
    </Suspense>
  );
});

/** Minimal colored patch, used without Pierre (tests, unsupported input). */
function PlainDiffBody({ file }: { file: DiffFile }) {
  return (
    <div className="overflow-x-auto" data-diff-plain>
      {file.hunks.map((hunk, index) => (
        <div key={`${index}:${hunk.header}`} className="border-b last:border-b-0">
          <div className="border-b bg-muted/40 px-3 py-1 font-mono text-xs text-muted-foreground">
            {hunk.header}
          </div>
          <pre className="m-0 font-mono text-xs">
            {hunk.lines.map((line, lineIndex) => (
              <div
                key={lineIndex}
                className={cn(
                  "whitespace-pre px-2",
                  line.kind === "add" && "bg-status-ok/10",
                  line.kind === "del" && "bg-status-err/10",
                )}
              >
                {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
                {line.text || " "}
              </div>
            ))}
          </pre>
        </div>
      ))}
    </div>
  );
}
