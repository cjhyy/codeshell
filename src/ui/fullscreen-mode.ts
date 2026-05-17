/**
 * Fullscreen mode — controllable at runtime via /fullscreen.
 *
 * Initial value: CODESHELL_FULLSCREEN env var ("0" = flow, anything else
 * including unset = fullscreen). Runtime switch goes through React Context
 * so subscribers re-render on toggle.
 *
 *   fullscreen=true  — AlternateScreen + ScrollBox + virtual-scroll +
 *     wheel/PgUp/PgDn intercepts. Default behavior.
 *   fullscreen=false — flow mode: no alt-screen, no wheel intercept;
 *     transcript flows downward and the terminal's scrollback owns history.
 *     VirtualMessageList renders only the most recent TAIL_ENTRY_LIMIT
 *     entries.
 *
 * On transition fullscreen→flow, FullscreenLayout flushes the current
 * transcript to stdout so older entries land in the terminal scrollback
 * before the alt-screen exits and React re-mounts the flow tree.
 */
import { createContext, useContext } from "react";

export const TAIL_ENTRY_LIMIT = 500;

export const INITIAL_FULLSCREEN_MODE = process.env.CODESHELL_FULLSCREEN !== "0";

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
