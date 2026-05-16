/**
 * Fullscreen mode flag — read once at process start.
 *
 *   CODESHELL_FULLSCREEN=1 (default) — alt-screen + ScrollBox + wheel/PgUp/PgDn
 *     intercepts. Long sessions use viewport-windowed React mount.
 *   CODESHELL_FULLSCREEN=0           — no alt-screen, no wheel intercept.
 *     Transcript flows downward naturally; terminal scrollback owns history.
 *     VirtualMessageList renders only the most recent TAIL_ENTRY_LIMIT entries
 *     since older content lives in the terminal's scrollback buffer.
 *
 * Module-level constant so React components can branch synchronously and
 * tree-shake the unused path.
 */
export const FULLSCREEN_MODE = process.env.CODESHELL_FULLSCREEN !== "0";

/**
 * In flow mode (fullscreen off), only the most recent N entries are mounted
 * as React fibers. Older entries are assumed to have scrolled out of the
 * visible region; the user reaches them via terminal scrollback (wheel
 * inside iTerm/Ghostty/tmux, NOT inside CodeShell). 500 is enough to cover
 * a few screenfuls of mixed user/assistant/tool output without paying the
 * full O(N) React reconcile cost on every state update in a long session.
 */
export const TAIL_ENTRY_LIMIT = 500;
