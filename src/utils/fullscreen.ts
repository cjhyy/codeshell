import { spawnSync } from 'child_process'
import { getIsInteractive } from '../bootstrap/state.js'
import { logForDebugging } from './debug.js'
import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'
import { execFileNoThrow } from './execFileNoThrow.js'

let loggedTmuxCcDisable = false
let checkedTmuxMouseHint = false

/**
 * Cached result from `tmux display-message -p '#{client_control_mode}'`.
 * undefined = not yet queried (or probe failed) — env heuristic stays authoritative.
 */
let tmuxControlModeProbed: boolean | undefined

/**
 * Env-var heuristic for iTerm2's tmux integration mode (`tmux -CC` / `tmux -2CC`).
 *
 * In `-CC` mode, iTerm2 renders tmux panes as native splits — tmux runs
 * as a server (TMUX is set) but iTerm2 is the actual terminal emulator
 * for each pane, so TERM_PROGRAM stays `iTerm.app` and TERM is iTerm2's
 * default (xterm-*). Contrast with regular tmux-inside-iTerm2, where tmux
 * overwrites TERM_PROGRAM to `tmux` and sets TERM to screen-* or tmux-*.
 */
function isTmuxControlModeEnvHeuristic(): boolean {
  if (!process.env.TMUX) return false
  if (process.env.TERM_PROGRAM !== 'iTerm.app') return false
  const term = process.env.TERM ?? ''
  return !term.startsWith('screen') && !term.startsWith('tmux')
}

/**
 * Sync one-shot probe: asks tmux directly whether this client is in control
 * mode via `#{client_control_mode}`. Runs on first isTmuxControlMode() call
 * when the env heuristic can't decide; result is cached.
 */
function probeTmuxControlModeSync(): void {
  tmuxControlModeProbed = isTmuxControlModeEnvHeuristic()
  if (tmuxControlModeProbed) return
  if (!process.env.TMUX) return
  if (process.env.TERM_PROGRAM) return
  let result
  try {
    result = spawnSync(
      'tmux',
      ['display-message', '-p', '#{client_control_mode}'],
      { encoding: 'utf8', timeout: 2000 },
    )
  } catch {
    return
  }
  if (result.status !== 0) return
  tmuxControlModeProbed = result.stdout.trim() === '1'
}

/**
 * True when running under `tmux -CC` (iTerm2 integration mode).
 *
 * The alt-screen / mouse-tracking path in fullscreen mode is unrecoverable
 * in -CC mode (double-click corrupts terminal state; mouse wheel is dead),
 * so callers auto-disable fullscreen.
 */
export function isTmuxControlMode(): boolean {
  if (tmuxControlModeProbed === undefined) probeTmuxControlModeSync()
  return tmuxControlModeProbed ?? false
}

export function _resetTmuxControlModeProbeForTesting(): void {
  tmuxControlModeProbed = undefined
  loggedTmuxCcDisable = false
}

/**
 * Runtime env-var check only. Ants default to on (CLAUDE_CODE_NO_FLICKER=0
 * to opt out); external users default to off (CLAUDE_CODE_NO_FLICKER=1 to
 * opt in).
 */
export function isFullscreenEnvEnabled(): boolean {
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_NO_FLICKER)) return false
  if (isEnvTruthy(process.env.CLAUDE_CODE_NO_FLICKER)) return true
  if (isTmuxControlMode()) {
    if (!loggedTmuxCcDisable) {
      loggedTmuxCcDisable = true
      logForDebugging(
        'fullscreen disabled: tmux -CC (iTerm2 integration mode) detected · set CLAUDE_CODE_NO_FLICKER=1 to override',
      )
    }
    return false
  }
  return process.env.USER_TYPE === 'ant'
}

/**
 * Whether fullscreen mode should enable SGR mouse tracking (DEC 1000/1002/1006).
 * Set CLAUDE_CODE_DISABLE_MOUSE=1 to keep alt-screen + virtualized scroll
 * but skip mouse capture, so tmux/kitty/terminal-native copy-on-select keeps working.
 */
export function isMouseTrackingEnabled(): boolean {
  return !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_MOUSE)
}

/**
 * Whether mouse click handling is disabled (clicks/drags ignored, wheel still
 * works). Set CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1 to prevent accidental clicks
 * from triggering cursor positioning, text selection, or message expansion.
 */
export function isMouseClicksDisabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_MOUSE_CLICKS)
}

/**
 * True when the fullscreen alt-screen layout is actually rendering —
 * requires an interactive REPL session AND the env var not explicitly
 * set falsy.
 */
export function isFullscreenActive(): boolean {
  return getIsInteractive() && isFullscreenEnvEnabled()
}

/**
 * One-time hint for tmux users in fullscreen with `mouse off`.
 *
 * Fire-and-forget from REPL startup. Returns the hint text once per
 * session if TMUX is set, fullscreen is active, and tmux's current
 * `mouse` option is off; null otherwise.
 */
export async function maybeGetTmuxMouseHint(): Promise<string | null> {
  if (!process.env.TMUX) return null
  if (!isFullscreenActive() || isTmuxControlMode()) return null
  if (checkedTmuxMouseHint) return null
  checkedTmuxMouseHint = true
  const { stdout, code } = await execFileNoThrow(
    'tmux',
    ['show', '-Av', 'mouse'],
    { useCwd: false, timeout: 2000 },
  )
  if (code !== 0 || stdout.trim() === 'on') return null
  return "tmux detected · scroll with PgUp/PgDn · or add 'set -g mouse on' to ~/.tmux.conf for wheel scroll"
}

/** Test-only: reset module-level once-per-session flags. */
export function _resetForTesting(): void {
  loggedTmuxCcDisable = false
  checkedTmuxMouseHint = false
}

/**
 * Whether fullscreen mode is available (alias for isFullscreenActive).
 */
export function isFullscreen(): boolean {
  return isFullscreenActive()
}
