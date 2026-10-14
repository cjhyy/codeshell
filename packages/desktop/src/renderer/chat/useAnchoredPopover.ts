import { type CSSProperties, type RefObject, useLayoutEffect, useState } from "react";

type Side = "top" | "bottom" | "left" | "right";
type Align = "start" | "end";

/** A point in viewport coordinates — used as a zero-size virtual anchor. */
export interface AnchorPoint {
  x: number;
  y: number;
}

interface Options {
  preferredSide?: Side;
  align?: Align;
  gap?: number;
  padding?: number;
  /** Optional content caps, combined with the viewport bounds. */
  maxWidth?: number | string;
  maxHeight?: number | string;
  /**
   * Anchor to a viewport point (e.g. the mouse cursor for a right-click
   * menu) instead of an element. When set, it overrides `anchorRef` and the
   * ref may be `null`. The point is treated as a zero-size rect, so the
   * popover sits to one side of it with the same flip/clamp logic.
   */
  point?: AnchorPoint | null;
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
    maxWidth: widthLimit,
    maxHeight: heightLimit,
    point = null,
  }: Options = {},
): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });

  // Collapse the optional point into a single stable dep so the deps array
  // length never changes between renders (callers that omit `point` would
  // otherwise flip the array size and trip React's hook-inputs check).
  const pointKey = point ? `${point.x},${point.y}` : "";

  useLayoutEffect(() => {
    if (!open) {
      setStyle({ visibility: "hidden" });
      return;
    }

    let frame = 0;

    const update = (): void => {
      const popover = popoverRef.current;
      if (!popover) return;

      // A cursor point is a zero-size rect; otherwise read the element.
      const anchorRect = point
        ? { top: point.y, bottom: point.y, left: point.x, right: point.x }
        : anchorRef.current?.getBoundingClientRect();
      if (!anchorRect) return;

      const viewportW = window.innerWidth;
      const viewportH = window.innerHeight;
      const maxWidth = Math.max(0, viewportW - padding * 2);
      const maxHeight = Math.max(0, viewportH - padding * 2);
      const width = Math.min(popover.offsetWidth, maxWidth);
      const height = Math.min(popover.offsetHeight, maxHeight);
      const horizontal = preferredSide === "left" || preferredSide === "right";
      const space = {
        top: anchorRect.top - padding - gap,
        bottom: viewportH - anchorRect.bottom - padding - gap,
        left: anchorRect.left - padding - gap,
        right: viewportW - anchorRect.right - padding - gap,
      };
      const opposite: Record<Side, Side> = {
        top: "bottom",
        bottom: "top",
        left: "right",
        right: "left",
      };
      let side = preferredSide;
      if ((horizontal ? width : height) > space[side] && space[opposite[side]] > space[side]) {
        side = opposite[side];
      }

      const rawTop =
        side === "top"
          ? anchorRect.top - height - gap
          : side === "bottom"
            ? anchorRect.bottom + gap
            : align === "end"
              ? anchorRect.bottom - height
              : anchorRect.top;
      const maxTop = Math.max(padding, viewportH - height - padding);
      const top = clamp(rawTop, padding, maxTop);

      const rawLeft =
        side === "left"
          ? anchorRect.left - width - gap
          : side === "right"
            ? anchorRect.right + gap
            : align === "end"
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
        maxWidth:
          widthLimit === undefined
            ? maxWidth
            : `min(${typeof widthLimit === "number" ? `${widthLimit}px` : widthLimit}, ${maxWidth}px)`,
        maxHeight:
          heightLimit === undefined
            ? maxHeight
            : `min(${typeof heightLimit === "number" ? `${heightLimit}px` : heightLimit}, ${maxHeight}px)`,
        overflowY: "auto",
        overscrollBehavior: "contain",
        overflowWrap: "anywhere",
      });
    };

    update();
    let previousAnchorBounds = "";
    const trackAnchor = (): void => {
      // ResizeObserver does not report position-only layout shifts. Composer
      // growth and inline controls can move an anchor without resizing it.
      const rect = anchorRef.current?.getBoundingClientRect();
      const bounds = rect ? `${rect.left},${rect.top},${rect.right},${rect.bottom}` : "";
      if (bounds !== previousAnchorBounds) {
        previousAnchorBounds = bounds;
        update();
      }
      frame = window.requestAnimationFrame(trackAnchor);
    };
    frame = window.requestAnimationFrame(point ? update : trackAnchor);
    // Content can change without a window resize (search results, async branch
    // loading, an inline editor, fonts). Reposition after those size changes too.
    const observer = new ResizeObserver(update);
    if (anchorRef.current && !point) observer.observe(anchorRef.current);
    if (popoverRef.current) observer.observe(popoverRef.current);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [
    align,
    anchorRef,
    gap,
    heightLimit,
    open,
    padding,
    pointKey,
    popoverRef,
    preferredSide,
    widthLimit,
  ]);

  return style;
}
