import type { ParsedKey } from '../parse-keypress.js'
import { TerminalEvent } from './terminal-event.js'

/**
 * Keyboard event dispatched through the DOM tree via capture/bubble.
 *
 * Follows browser KeyboardEvent semantics: `key` is the literal character
 * for printable keys ('a', '3', ' ', '/') and a multi-char name for
 * special keys ('down', 'return', 'escape', 'f1'). The idiomatic
 * printable-char check is `e.key.length === 1`.
 */
export class KeyboardEvent extends TerminalEvent {
  readonly key: string
  readonly ctrl: boolean
  readonly shift: boolean
  readonly meta: boolean
  readonly superKey: boolean
  readonly fn: boolean

  constructor(parsedKey: ParsedKey) {
    super('keydown', { bubbles: true, cancelable: true })

    this.key = keyFromParsed(parsedKey)
    this.ctrl = parsedKey.ctrl
    this.shift = parsedKey.shift
    this.meta = parsedKey.meta || parsedKey.option
    this.superKey = parsedKey.super
    this.fn = parsedKey.fn
  }
}

function isPrintable(char: string): boolean {
  const code = char.charCodeAt(0)
  return code >= 0x20 && code !== 0x7f
}

function keyFromParsed(parsed: ParsedKey): string {
  const seq = parsed.sequence ?? ''
  const name = parsed.name ?? ''

  // Encoded space (CSI u / modifyOtherKeys) is named 'space'; the key is the
  // literal character, as browsers report e.key === ' ' with modifiers.
  if (name === 'space') return ' '

  // Ctrl combos: sequence is a control byte (\x03 for ctrl+c), name is the
  // letter. Browsers report e.key === 'c' with e.ctrlKey === true.
  if (parsed.ctrl) return name

  // Single printable char (space through ~, plus anything above ASCII):
  // use the literal char. Browsers report e.key === '3', not 'Digit3'.
  if (seq.length === 1 && isPrintable(seq)) return seq

  // Legacy Alt+printable arrives ESC-prefixed (\x1bz); the key is the
  // character, with Alt carried by `meta`.
  if (seq.length === 2 && seq[0] === '\x1b' && isPrintable(seq[1]!)) return seq[1]!

  // Special keys (arrows, F-keys, return, tab, escape, etc.): sequence is
  // either an escape sequence (\x1b[B) or a control byte (\r, \t), so use
  // the parsed name. Browsers report e.key === 'ArrowDown'.
  return name || seq
}
