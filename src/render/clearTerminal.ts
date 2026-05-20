/**
 * Cross-platform terminal clearing with scrollback support.
 * Detects modern terminals that support ESC[3J for clearing scrollback.
 */

import {
  CURSOR_HOME,
  csi,
  ERASE_SCREEN,
  ERASE_SCROLLBACK,
} from './termio/csi.js'

// HVP (Horizontal Vertical Position) - legacy Windows cursor home
const CURSOR_HOME_WINDOWS = csi(0, 'f')

function isWindowsTerminal(): boolean {
  return process.platform === 'win32' && !!process.env.WT_SESSION
}

function isMintty(): boolean {
  // mintty 3.1.5+ sets TERM_PROGRAM to 'mintty'
  if (process.env.TERM_PROGRAM === 'mintty') {
    return true
  }
  // GitBash/MSYS2/MINGW use mintty and set MSYSTEM
  if (process.platform === 'win32' && process.env.MSYSTEM) {
    return true
  }
  return false
}

function isModernWindowsTerminal(): boolean {
  // Windows Terminal sets WT_SESSION environment variable
  if (isWindowsTerminal()) {
    return true
  }

  // VS Code integrated terminal on Windows with ConPTY support
  if (
    process.platform === 'win32' &&
    process.env.TERM_PROGRAM === 'vscode' &&
    process.env.TERM_PROGRAM_VERSION
  ) {
    return true
  }

  // mintty (GitBash/MSYS2/Cygwin) supports modern escape sequences
  if (isMintty()) {
    return true
  }

  return false
}

/**
 * Returns the ANSI escape sequence to clear the terminal.
 *
 * `preserveScrollback=true` omits ERASE_SCROLLBACK (CSI 3J) so the user's
 * scrollback buffer (and scroll position) survives a mid-stream fullReset.
 * Used by log-update when emitting a flicker reset in flow mode — alt-screen
 * has no user-visible scrollback so the default (clear it) is fine there.
 */
export function getClearTerminalSequence(
  options: { preserveScrollback?: boolean } = {},
): string {
  const preserve = options.preserveScrollback === true
  if (process.platform === 'win32') {
    if (isModernWindowsTerminal()) {
      return ERASE_SCREEN + (preserve ? '' : ERASE_SCROLLBACK) + CURSOR_HOME
    } else {
      // Legacy Windows console - can't clear scrollback
      return ERASE_SCREEN + CURSOR_HOME_WINDOWS
    }
  }
  return ERASE_SCREEN + (preserve ? '' : ERASE_SCROLLBACK) + CURSOR_HOME
}

/**
 * Clears the terminal screen. On supported terminals, also clears scrollback.
 */
export const clearTerminal = getClearTerminalSequence()
