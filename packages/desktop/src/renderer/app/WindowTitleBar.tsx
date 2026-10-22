import { useRef, type CSSProperties } from "react";
import { useWindowTitleBar } from "./useWindowTitleBar";

/** Retain draggable, themed chrome while chat navigation is replaced or loading. */
export function WindowTitleBar({ isFullscreen = false }: { isFullscreen?: boolean }) {
  const headerRef = useRef<HTMLElement | null>(null);
  useWindowTitleBar(headerRef);
  if (
    globalThis.window?.codeshell?.platform !== "win32" ||
    globalThis.window?.codeshell?.hasWindowTitleBarOverlay !== true
  )
    return null;
  return (
    <header
      ref={headerRef}
      data-window-titlebar
      data-platform="win32"
      data-window-state={isFullscreen ? "fullscreen" : "windowed"}
      data-theme-surface="titlebar"
      className="flex h-[var(--cs-titlebar-height,2.75rem)] shrink-0 flex-col border-b border-border/70 text-foreground"
      style={{ WebkitAppRegion: "drag" } as CSSProperties}
    >
      <div data-window-titlebar-content className="flex min-h-0 min-w-0 flex-1 items-center">
        <span className="min-w-0 truncate px-3 text-xs font-semibold tracking-tight">
          code-shell
        </span>
      </div>
    </header>
  );
}
