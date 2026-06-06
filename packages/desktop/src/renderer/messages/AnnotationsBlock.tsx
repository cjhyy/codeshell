import React from "react";
import type { ParsedAnnotationBlock } from "../chat/anchors";

/**
 * Renders the `<codeshell-annotations>` block a user attaches to a turn
 * (diff/browser/file comments pinned from the panels) as a distinct styled
 * card instead of raw XML + `[1] …` prose. Left color bar + tinted background
 * + rounded border set it apart from the user's own message text.
 *
 * Pure presentational — the block is parsed upstream by `extractAnnotations`.
 */
export function AnnotationsBlock({ block }: { block: ParsedAnnotationBlock }) {
  return (
    <div className="mb-2 rounded-md border border-border border-l-2 border-l-primary bg-primary/5 px-2.5 py-2 text-[12px] leading-relaxed">
      <div className="mb-1.5 font-medium text-muted-foreground">{block.header}</div>
      <ol className="m-0 flex list-none flex-col gap-2 p-0">
        {block.entries.map((entry, i) => (
          <li key={i} className="min-w-0">
            <div className="flex min-w-0 items-baseline gap-1.5">
              <span className="shrink-0 rounded bg-muted px-1 py-px text-[10px] uppercase tracking-wide text-muted-foreground">
                {entry.kindLabel}
              </span>
              <span className="min-w-0 break-words font-mono text-[11px] text-foreground">
                {entry.label}
              </span>
            </div>
            {entry.locator.length > 0 && (
              <dl className="m-0 mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
                {entry.locator.map((loc, j) => (
                  <React.Fragment key={j}>
                    <dt className="text-muted-foreground">{loc.key}</dt>
                    <dd className="m-0 min-w-0 break-words font-mono text-[11px] text-foreground/90">
                      {loc.value}
                    </dd>
                  </React.Fragment>
                ))}
              </dl>
            )}
            {entry.comment && (
              <div className="mt-1 whitespace-pre-wrap break-words text-foreground">
                {entry.comment}
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
