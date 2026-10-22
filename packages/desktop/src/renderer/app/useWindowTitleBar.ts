import { useLayoutEffect, type RefObject } from "react";
import type { WindowTitleBarOverlay } from "../../shared/window-titlebar";

// Chat, settings and startup own different headers in the same native window.
// Share the last request so revealing an older header restores its appearance
// even when that hook's own palette and dimensions have not changed.
let lastBridge: unknown;
let lastRequestKey: string | undefined;
let requestSequence = 0;

function symbolColor(color: string): string | null {
  const rgb = color.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (!rgb) return null;
  return `#${rgb
    .slice(1, 4)
    .map((channel) => Math.min(255, Math.max(0, Math.round(Number(channel)))))
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

function changesThemePack(record: MutationRecord): boolean {
  const target = record.target instanceof Element ? record.target : record.target.parentElement;
  if (target?.closest("#cs-theme-pack")) return true;
  return [...record.addedNodes, ...record.removedNodes].some(
    (node) => node instanceof Element && node.id === "cs-theme-pack",
  );
}

/** Keep native Windows caption buttons aligned with the currently visible header. */
export function useWindowTitleBar(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const bridge = window.codeshell;
    const header = ref.current;
    if (
      bridge?.platform !== "win32" ||
      bridge.hasWindowTitleBarOverlay !== true ||
      !bridge.setWindowTitleBarOverlay ||
      !header
    )
      return;

    let frame: number | undefined;
    let disposed = false;
    const sync = (): void => {
      frame = undefined;
      if (disposed || !header.isConnected) return;
      let rect = header.getBoundingClientRect();
      const style = window.getComputedStyle(header);
      // A mounted chat header remains hidden behind the settings route. Its
      // observers must never overwrite the visible settings header's style.
      if (rect.width <= 0 || rect.height <= 0 || style.visibility === "hidden") return;
      const rawZoom = bridge.getWindowZoomFactor?.() ?? 1;
      const zoom = Number.isFinite(rawZoom) && rawZoom > 0 ? rawZoom : 1;
      // Preserve a usable native button height when the app is zoomed out.
      // This CSS minimum does not depend on the previous native overlay size.
      const minimumHeight = `${32 / zoom}px`;
      if (header.style.getPropertyValue("--cs-window-titlebar-min-height") !== minimumHeight) {
        header.style.setProperty("--cs-window-titlebar-min-height", minimumHeight);
        rect = header.getBoundingClientRect();
      }
      if (!Number.isFinite(rect.bottom)) return;
      const overlay: WindowTitleBarOverlay = {
        symbolColor:
          symbolColor(style.color) ??
          (document.documentElement.classList.contains("dark") ? "#f5f5f5" : "#242424"),
        // Native controls begin at the viewport origin; the header begins
        // inside the theme's decorative frame, so include that top inset.
        height: Math.min(256, Math.max(32, Math.ceil(rect.bottom))),
      };
      const key = `${overlay.symbolColor}:${overlay.height}:${zoom}:${window.devicePixelRatio}`;
      if (lastBridge === bridge && lastRequestKey === key) return;
      lastBridge = bridge;
      lastRequestKey = key;
      const sequence = ++requestSequence;
      void bridge.setWindowTitleBarOverlay(overlay).catch((error: unknown) => {
        // A rejected older request must not invalidate a newer successful one.
        if (sequence === requestSequence) lastRequestKey = undefined;
        bridge.log?.("window.titlebar-overlay.failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    };
    const schedule = (): void => {
      if (!disposed && frame === undefined) frame = window.requestAnimationFrame(sync);
    };
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(header);
    const appearanceObserver = new MutationObserver(schedule);
    appearanceObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    const packObserver = new MutationObserver((records) => {
      if (records.some(changesThemePack)) schedule();
    });
    packObserver.observe(document.head, { childList: true, characterData: true, subtree: true });
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      disposed = true;
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      appearanceObserver.disconnect();
      packObserver.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [ref]);
}
