/**
 * Fullscreen mode — controllable at runtime via /fullscreen.
 *
 * Initial value: CODESHELL_FULLSCREEN env var.
 *   "0" / "false" / "off" → flow mode
 *   anything else (including unset) → fullscreen (default)
 *
 * Default is FULLSCREEN. Previously the default was flow mode, but flow had
 * a real cost: terminal-side line wrap on resize left "duplicate content" in
 * the user's scrollback because ERASE_SCREEN (CSI 2J) cannot reach rows the
 * terminal has already pushed up. Alt-screen owns its own buffer, so resize
 * repaints cleanly. Users who want the old behavior (transcript flushes into
 * the terminal's native scrollback) set CODESHELL_FULLSCREEN=0 or run
 * /fullscreen off at runtime. The switch flips via React Context so
 * subscribers re-render on toggle.
 *
 *   fullscreen=true  — AlternateScreen + ScrollBox + virtual-scroll +
 *     wheel/PgUp/PgDn intercepts. Resize repaints cleanly.
 *   fullscreen=false — flow mode: no alt-screen, no wheel intercept;
 *     transcript flows downward and the terminal's scrollback owns history.
 *     Committed entries are flushed once via <Static> into stdout; only the
 *     active streaming tail stays in the diff loop.
 *
 * On transition fullscreen→flow, FullscreenLayout flushes the current
 * transcript to stdout so older entries land in the terminal scrollback
 * before the alt-screen exits and React re-mounts the flow tree.
 */
import { createContext, useContext } from "react";

export const TAIL_ENTRY_LIMIT = 500;

function parseFullscreenEnv(): boolean {
  const raw = process.env.CODESHELL_FULLSCREEN;
  // Unset → default (fullscreen).
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  // Explicit opt-out; anything else (including "1", "true", "on", "", "yes")
  // → fullscreen.
  return !(v === "0" || v === "false" || v === "off");
}

export const INITIAL_FULLSCREEN_MODE = parseFullscreenEnv();

export interface FullscreenModeValue {
  fullscreen: boolean;
  setFullscreen: (next: boolean) => void;
  toggleFullscreen: () => void;
}

// Default value matches initial env state; runtime overrides via the Provider
// inserted at the top of App.
export const FullscreenModeContext = createContext<FullscreenModeValue>({
  fullscreen: INITIAL_FULLSCREEN_MODE,
  setFullscreen: () => {},
  toggleFullscreen: () => {},
});

export function useFullscreenMode(): FullscreenModeValue {
  return useContext(FullscreenModeContext);
}
