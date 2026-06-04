import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  /** Collapsed max height in px. Content taller than this is clamped + toggled. */
  maxHeight?: number;
  className?: string;
  children: React.ReactNode;
}

/**
 * Clamps overly-long content to a fixed height by default with an expand/collapse
 * toggle. Used for user message bubbles, where a pasted wall of text would
 * otherwise dominate the transcript.
 *
 * Measures the natural content height after layout; only renders the toggle when
 * the content actually overflows the cap (short messages stay untouched, no
 * button). Re-measures when children change so streaming/edited content keeps an
 * accurate overflow decision.
 */
export function CollapsibleContent({ maxHeight = 320, className, children }: Props) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Measure synchronously after DOM mutations so we never flash an un-clamped
  // tall block before deciding to collapse it.
  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    setOverflows(el.scrollHeight > maxHeight + 1);
  });

  // Re-measure on viewport resize — wrapping changes content height, which can
  // flip the overflow decision (e.g. window narrowed → text wraps taller).
  useEffect(() => {
    const onResize = (): void => {
      const el = innerRef.current;
      if (el) setOverflows(el.scrollHeight > maxHeight + 1);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [maxHeight]);

  const clamped = overflows && !expanded;

  return (
    <div className={className}>
      <div
        ref={innerRef}
        className={cn("relative overflow-hidden", clamped && "[mask-image:linear-gradient(to_bottom,black_calc(100%-2.5rem),transparent)]")}
        style={clamped ? { maxHeight } : undefined}
      >
        {children}
      </div>
      {overflows && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {expanded ? (
            <>
              <ChevronUp size={12} /> 收起
            </>
          ) : (
            <>
              <ChevronDown size={12} /> 展开
            </>
          )}
        </button>
      )}
    </div>
  );
}
