/**
 * Fullscreen mode — controllable at runtime via /fullscreen.
 *
 * Initial value: CODESHELL_FULLSCREEN env var ("1" / "true" / "on" = fullscreen,
 * anything else including unset = flow). Default is FLOW mode, matching Claude
 * Code's behavior — output flows downward into the terminal scrollback. Users
 * who want the alt-screen + ScrollBox experience set CODESHELL_FULLSCREEN=1
 * or run /fullscreen on at runtime. The switch flips via React Context so
 * subscribers re-render on toggle.
 *
 *   fullscreen=true  — AlternateScreen + ScrollBox + virtual-scroll +
 *     wheel/PgUp/PgDn intercepts.
 *   fullscreen=false — flow mode (default): no alt-screen, no wheel intercept;
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
  const v = (process.env.CODESHELL_FULLSCREEN ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on";
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
