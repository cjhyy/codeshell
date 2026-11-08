import { useLayoutEffect, useRef } from "react";
import type { MimiBubblePanel } from "../../shared/mimi-presence";

/** Only the visible panel, not its transparent native window, owns the mouse. */
export function usePetBubbleMouse(
  enabled: boolean,
  panel: MimiBubblePanel | null,
  report: ((interactive: boolean) => void) | undefined,
) {
  const content = useRef<HTMLElement>(null);
  const pointer = useRef<{ x: number; y: number; originX: number; originY: number } | null>(null);

  useLayoutEffect(() => {
    if (!enabled || !report) {
      pointer.current = null;
      return;
    }
    const section = content.current;
    if (!panel || !section) {
      pointer.current = null;
      report(false);
      return;
    }
    let active = true;
    let pressed = false;
    const remember = (event: MouseEvent) => {
      pointer.current = {
        x: event.clientX,
        y: event.clientY,
        originX: window.screenX,
        originY: window.screenY,
      };
    };
    const hitContent = () => {
      const point = pointer.current;
      const target =
        point && point.originX === window.screenX && point.originY === window.screenY
          ? document.elementFromPoint(point.x, point.y)
          : null;
      return target !== null && section.contains(target);
    };
    const update = () => {
      if (!active) return;
      // Moving the native window invalidates cached client coordinates. Main
      // yields the mouse on relocation; wait for a fresh forwarded mousemove.
      report(pressed || hitContent());
    };
    const move = (event: MouseEvent) => {
      if (event.buttons === 0) pressed = false;
      remember(event);
      // Do not deduplicate here: Main may have reset capture after a move or
      // hide. Electron forwards mousemove while the window ignores clicks.
      update();
    };
    const down = (event: MouseEvent) => {
      remember(event);
      // Text selection and scrollbar drags must retain their mouseup even if
      // the pointer leaves the panel while the button is held.
      pressed = hitContent();
      update();
    };
    const up = (event: MouseEvent) => {
      pressed = false;
      remember(event);
      update();
    };
    const leave = (event: MouseEvent) => {
      if (event.relatedTarget !== null) return;
      pointer.current = null;
      update();
    };
    const blur = () => {
      pressed = false;
      pointer.current = null;
      report(false);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseout", leave);
    window.addEventListener("mousedown", down);
    window.addEventListener("mouseup", up);
    window.addEventListener("blur", blur);
    // A dismissed task can shrink the panel beneath a stationary pointer.
    const observer = new ResizeObserver(update);
    observer.observe(section);
    update();
    return () => {
      active = false;
      observer.disconnect();
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseout", leave);
      window.removeEventListener("mousedown", down);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("blur", blur);
      report(false);
    };
  }, [enabled, panel, report]);

  return content;
}
