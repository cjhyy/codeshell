import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "../i18n/I18nProvider";

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
  const { t } = useT();
  const contentId = useId();
  const innerRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const measure = useCallback((): void => {
    const el = innerRef.current;
    if (el) setOverflows(el.scrollHeight > maxHeight + 1);
  }, [maxHeight]);

  // Measure synchronously after DOM mutations so we never flash an un-clamped
  // tall block before deciding to collapse it.
  useLayoutEffect(measure, [measure, children]);

  // A dock/side-panel resize changes wrapping without resizing the window or
  // re-rendering this message. Observe the natural inner content, outside the
  // height clamp, so hidden growth is measurable and clamping cannot cause an
  // observer feedback loop. Keep the window listener for older environments.
  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    let active = true;
    const onResize = () => {
      if (active) measure();
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onResize);
    observer?.observe(el);
    window.addEventListener("resize", onResize);
    return () => {
      active = false;
      observer?.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [measure]);

  const clamped = overflows && !expanded;

  return (
    <div className={className}>
      <div
        id={contentId}
        className={cn(
          "relative overflow-hidden",
          clamped && "[mask-image:linear-gradient(to_bottom,black_calc(100%-2.5rem),transparent)]",
        )}
        style={clamped ? { maxHeight } : undefined}
      >
        <div ref={innerRef} className="flow-root">
          {children}
        </div>
      </div>
      {overflows && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 inline-flex min-h-6 items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {expanded ? (
            <>
              <ChevronUp size={12} /> {t("msg.collapsible.collapse")}
            </>
          ) : (
            <>
              <ChevronDown size={12} /> {t("msg.collapsible.expand")}
            </>
          )}
        </button>
      )}
    </div>
  );
}
