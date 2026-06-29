import React, { type CSSProperties, type RefObject, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Rect } from "./types";

/**
 * Position a popover near a webview-viewport `rect`, with real collision
 * detection against the panel container (the popover's `offsetParent`, i.e.
 * the `relative overflow-hidden` content box): prefer below the element, flip
 * above when there's no room, and clamp on all four edges so a `w-72` box near
 * the right/bottom edge stays fully visible instead of overflowing the panel.
 */
export function useRectPopoverStyle(rect: Rect, ref: RefObject<HTMLElement | null>): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const { x, y, width, height } = rect;

  useLayoutEffect(() => {
    let frame = 0;
    const update = (): void => {
      const el = ref.current;
      const parent = el?.offsetParent as HTMLElement | null;
      if (!el || !parent) return;

      const pad = 4;
      const gap = 6;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const maxW = parent.clientWidth;
      const maxH = parent.clientHeight;

      // Prefer below the rect; flip above when it would overflow the bottom and
      // there's more room above.
      const belowTop = y + height + gap;
      const aboveTop = y - h - gap;
      const top =
        belowTop + h + pad > maxH && aboveTop >= pad
          ? clampPos(aboveTop, h, maxH, pad)
          : clampPos(belowTop, h, maxH, pad);
      const left = clampPos(x, w, maxW, pad);

      setStyle({ top, left, visibility: "visible" });
    };
    update();
    frame = window.requestAnimationFrame(update);
    window.addEventListener("resize", update);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
    };
  }, [x, y, width, height, ref]);

  return style;
}

/** Clamp a start coordinate so a `size`-long box stays within `[pad, max-pad]`. */
export function clampPos(start: number, size: number, max: number, pad: number): number {
  return Math.min(Math.max(start, pad), Math.max(pad, max - size - pad));
}

/** Position children near a webview-viewport rect, clamped into view. */
export function FloatingAt({ rect, children }: { rect: Rect; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const style = useRectPopoverStyle(rect, ref);
  return (
    <div ref={ref} className="absolute z-30 w-72 max-w-[90%]" style={style}>
      {children}
    </div>
  );
}

export function IconBtn({
  children,
  onClick,
  disabled,
  label,
  active,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  label: string;
  active?: boolean;
}) {
  return (
    <Button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      variant="ghost"
      size="icon"
      className={
        "h-8 w-8 disabled:opacity-40 " +
        (active ? "bg-primary/15 text-primary" : "text-muted-foreground")
      }
    >
      {children}
    </Button>
  );
}
