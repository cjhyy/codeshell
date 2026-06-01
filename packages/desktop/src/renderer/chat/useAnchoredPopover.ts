import { type CSSProperties, type RefObject, useLayoutEffect, useState } from "react";

type Side = "top" | "bottom";
type Align = "start" | "end";

interface Options {
  preferredSide?: Side;
  align?: Align;
  gap?: number;
  padding?: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

export function useAnchoredPopover(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  popoverRef: RefObject<HTMLElement | null>,
  {
    preferredSide = "top",
    align = "start",
    gap = 6,
    padding = 10,
  }: Options = {},
): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });

  useLayoutEffect(() => {
    if (!open) {
      setStyle({ visibility: "hidden" });
      return;
    }

    let frame = 0;

    const update = (): void => {
      const anchor = anchorRef.current;
      const popover = popoverRef.current;
      if (!anchor || !popover) return;

      const anchorRect = anchor.getBoundingClientRect();
      const width = popover.offsetWidth;
      const height = popover.offsetHeight;
      const viewportW = window.innerWidth;
      const viewportH = window.innerHeight;

      const topSpace = anchorRect.top - padding - gap;
      const bottomSpace = viewportH - anchorRect.bottom - padding - gap;
      let side = preferredSide;

      if (preferredSide === "top" && height > topSpace && bottomSpace > topSpace) {
        side = "bottom";
      } else if (preferredSide === "bottom" && height > bottomSpace && topSpace > bottomSpace) {
        side = "top";
      }

      const rawTop = side === "top"
        ? anchorRect.top - height - gap
        : anchorRect.bottom + gap;
      const maxTop = Math.max(padding, viewportH - height - padding);
      const top = clamp(rawTop, padding, maxTop);

      const rawLeft = align === "end"
        ? anchorRect.right - width
        : anchorRect.left;
      const maxLeft = Math.max(padding, viewportW - width - padding);
      const left = clamp(rawLeft, padding, maxLeft);

      setStyle({
        position: "fixed",
        top,
        left,
        zIndex: 50,
        visibility: "visible",
      });
    };

    update();
    frame = window.requestAnimationFrame(update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [align, anchorRef, gap, open, padding, popoverRef, preferredSide]);

  return style;
}
