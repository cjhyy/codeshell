/**
 * Key name → CDP Input.dispatchKeyEvent fields. Translated from browser-use's
 * actor/utils.py `get_key_info` + the combination dispatch in
 * default_action_watchdog.py. Self-contained (no deps) so it travels with the
 * package.
 *
 * Modifier bitmask (CDP Input.dispatchKeyEvent `modifiers`): Alt=1, Control=2,
 * Meta=4, Shift=8 — OR'd together for combinations like "Control+a".
 */

/** code + Windows virtual key code for a named key (or single char). */
export interface KeyInfo {
  code: string;
  windowsVirtualKeyCode: number | null;
}

const KEY_MAP: Record<string, [string, number | null]> = {
  Backspace: ["Backspace", 8],
  Tab: ["Tab", 9],
  Enter: ["Enter", 13],
  Escape: ["Escape", 27],
  Space: ["Space", 32],
  " ": ["Space", 32],
  PageUp: ["PageUp", 33],
  PageDown: ["PageDown", 34],
  End: ["End", 35],
  Home: ["Home", 36],
  ArrowLeft: ["ArrowLeft", 37],
  ArrowUp: ["ArrowUp", 38],
  ArrowRight: ["ArrowRight", 39],
  ArrowDown: ["ArrowDown", 40],
  Insert: ["Insert", 45],
  Delete: ["Delete", 46],
  Shift: ["ShiftLeft", 16],
  ShiftLeft: ["ShiftLeft", 16],
  ShiftRight: ["ShiftRight", 16],
  Control: ["ControlLeft", 17],
  ControlLeft: ["ControlLeft", 17],
  ControlRight: ["ControlRight", 17],
  Alt: ["AltLeft", 18],
  AltLeft: ["AltLeft", 18],
  AltRight: ["AltRight", 18],
  Meta: ["MetaLeft", 91],
  MetaLeft: ["MetaLeft", 91],
  MetaRight: ["MetaRight", 92],
  F1: ["F1", 112], F2: ["F2", 113], F3: ["F3", 114], F4: ["F4", 115],
  F5: ["F5", 116], F6: ["F6", 117], F7: ["F7", 118], F8: ["F8", 119],
  F9: ["F9", 120], F10: ["F10", 121], F11: ["F11", 122], F12: ["F12", 123],
  F13: ["F13", 124], F14: ["F14", 125], F15: ["F15", 126], F16: ["F16", 127],
  F17: ["F17", 128], F18: ["F18", 129], F19: ["F19", 130], F20: ["F20", 131],
  F21: ["F21", 132], F22: ["F22", 133], F23: ["F23", 134], F24: ["F24", 135],
  NumLock: ["NumLock", 144],
  Numpad0: ["Numpad0", 96], Numpad1: ["Numpad1", 97], Numpad2: ["Numpad2", 98],
  Numpad3: ["Numpad3", 99], Numpad4: ["Numpad4", 100], Numpad5: ["Numpad5", 101],
  Numpad6: ["Numpad6", 102], Numpad7: ["Numpad7", 103], Numpad8: ["Numpad8", 104],
  Numpad9: ["Numpad9", 105],
  NumpadMultiply: ["NumpadMultiply", 106],
  "*": ["NumpadMultiply", 106],
  NumpadAdd: ["NumpadAdd", 107],
  NumpadSubtract: ["NumpadSubtract", 109],
  NumpadDecimal: ["NumpadDecimal", 110],
  NumpadDivide: ["NumpadDivide", 111],
  CapsLock: ["CapsLock", 20],
  ScrollLock: ["ScrollLock", 145],
  Semicolon: ["Semicolon", 186], ";": ["Semicolon", 186],
  Equal: ["Equal", 187], "=": ["Equal", 187],
  Comma: ["Comma", 188], ",": ["Comma", 188],
  Minus: ["Minus", 189], "-": ["Minus", 189],
  Period: ["Period", 190], ".": ["Period", 190],
  Slash: ["Slash", 191], "/": ["Slash", 191],
  Backquote: ["Backquote", 192], "`": ["Backquote", 192],
  BracketLeft: ["BracketLeft", 219], "[": ["BracketLeft", 219],
  Backslash: ["Backslash", 220], "\\": ["Backslash", 220],
  BracketRight: ["BracketRight", 221], "]": ["BracketRight", 221],
  Quote: ["Quote", 222], "'": ["Quote", 222],
  "!": ["Digit1", 49],
  "@": ["Digit2", 50],
  "#": ["Digit3", 51],
  "$": ["Digit4", 52],
  "%": ["Digit5", 53],
  "^": ["Digit6", 54],
  "&": ["Digit7", 55],
  "(": ["Digit9", 57],
  ")": ["Digit0", 48],
  _: ["Minus", 189],
  "+": ["Equal", 187],
  "{": ["BracketLeft", 219],
  "|": ["Backslash", 220],
  "}": ["BracketRight", 221],
  ":": ["Semicolon", 186],
  "\"": ["Quote", 222],
  "<": ["Comma", 188],
  ">": ["Period", 190],
  "?": ["Slash", 191],
  "~": ["Backquote", 192],
  Clear: ["Clear", 12],
  Pause: ["Pause", 19],
  ContextMenu: ["ContextMenu", 93],
};

/** Aliases the agent may use (lowercased) → canonical key name. */
const ALIASES: Record<string, string> = {
  ctrl: "Control",
  control: "Control",
  alt: "Alt",
  option: "Alt",
  meta: "Meta",
  cmd: "Meta",
  command: "Meta",
  win: "Meta",
  shift: "Shift",
  enter: "Enter",
  return: "Enter",
  esc: "Escape",
  escape: "Escape",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  pageup: "PageUp",
  pagedown: "PageDown",
  home: "Home",
  end: "End",
};

/** Modifier name → CDP modifier bitmask value. */
export const MODIFIER_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

const TEXT_BLOCKING_MODIFIERS = MODIFIER_BITS.Alt | MODIFIER_BITS.Control | MODIFIER_BITS.Meta;

const SHIFT_TEXT: Record<string, string> = {
  "`": "~",
  "1": "!",
  "2": "@",
  "3": "#",
  "4": "$",
  "5": "%",
  "6": "^",
  "7": "&",
  "8": "*",
  "9": "(",
  "0": ")",
  "-": "_",
  "=": "+",
  "[": "{",
  "\\": "|",
  "]": "}",
  ";": ":",
  "'": "\"",
  ",": "<",
  ".": ">",
  "/": "?",
};

const NAMED_PRINTABLE_TEXT: Record<string, string> = {
  Space: " ",
  Numpad0: "0",
  Numpad1: "1",
  Numpad2: "2",
  Numpad3: "3",
  Numpad4: "4",
  Numpad5: "5",
  Numpad6: "6",
  Numpad7: "7",
  Numpad8: "8",
  Numpad9: "9",
  NumpadMultiply: "*",
  NumpadAdd: "+",
  NumpadSubtract: "-",
  NumpadDecimal: ".",
  NumpadDivide: "/",
  Semicolon: ";",
  Equal: "=",
  Comma: ",",
  Minus: "-",
  Period: ".",
  Slash: "/",
  Backquote: "`",
  BracketLeft: "[",
  Backslash: "\\",
  BracketRight: "]",
  Quote: "'",
};

/** Resolve a single token (alias or canonical) to its canonical key name. */
export function normalizeKey(token: string): string {
  const t = token.trim();
  return ALIASES[t.toLowerCase()] ?? t;
}

/** code + virtual key code for a canonical key name (or single char). */
export function keyInfo(key: string): KeyInfo {
  const hit = KEY_MAP[key];
  if (hit) return { code: hit[0], windowsVirtualKeyCode: hit[1] };
  if (key.length === 1) {
    if (/[a-zA-Z]/.test(key)) {
      return { code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) };
    }
    if (/[0-9]/.test(key)) {
      return { code: `Digit${key}`, windowsVirtualKeyCode: key.charCodeAt(0) };
    }
  }
  return { code: key, windowsVirtualKeyCode: null };
}

/** One CDP Input.dispatchKeyEvent payload (type + key fields). */
export interface KeyEvent {
  type: "keyDown" | "keyUp";
  key: string;
  code: string;
  text?: string;
  unmodifiedText?: string;
  windowsVirtualKeyCode?: number;
  nativeVirtualKeyCode?: number;
  modifiers?: number;
}

function printableText(key: string, modifiers = 0): string | null {
  if (modifiers & TEXT_BLOCKING_MODIFIERS) return null;

  const base = NAMED_PRINTABLE_TEXT[key] ?? (key.length === 1 ? key : null);
  if (base === null) return null;
  if (base.length !== 1 || base < " ") return null;

  if (!(modifiers & MODIFIER_BITS.Shift)) return base;
  if (/[a-z]/.test(base)) return base.toUpperCase();
  if (/[A-Z]/.test(base)) return base;
  return SHIFT_TEXT[base] ?? base;
}

/**
 * Plan the CDP key-event sequence for a key spec like "Enter", "Tab",
 * "ArrowDown", or a combination "Control+a" / "Meta+Shift+z". Returns the
 * ordered list of dispatchKeyEvent payloads; the driver just sends them.
 *
 * Combination order (matches browser-use): modifier keyDowns → main keyDown
 * (with bitmask) → main keyUp (with bitmask) → modifier keyUps (reversed).
 */
export function planKeySequence(spec: string): KeyEvent[] {
  const parts = spec.split("+").map(normalizeKey).filter((p) => p.length > 0);
  if (parts.length === 0) return [];

  const main = parts[parts.length - 1]!;
  const modifiers = parts.slice(0, -1);
  const bitmask = modifiers.reduce((m, mod) => m | (MODIFIER_BITS[mod] ?? 0), 0);

  const ev = (type: "keyDown" | "keyUp", key: string, modifiers?: number): KeyEvent => {
    const info = keyInfo(key);
    const e: KeyEvent = { type, key, code: info.code };
    if (info.windowsVirtualKeyCode !== null) {
      e.windowsVirtualKeyCode = info.windowsVirtualKeyCode;
      e.nativeVirtualKeyCode = info.windowsVirtualKeyCode;
    }
    if (modifiers) e.modifiers = modifiers;
    const text = type === "keyDown" ? printableText(key, modifiers) : null;
    if (text !== null) {
      e.text = text;
      e.unmodifiedText = text;
    }
    return e;
  };

  if (modifiers.length === 0) {
    return [ev("keyDown", main), ev("keyUp", main)];
  }
  return [
    ...modifiers.map((mod) => ev("keyDown", mod)),
    ev("keyDown", main, bitmask),
    ev("keyUp", main, bitmask),
    ...modifiers.slice().reverse().map((mod) => ev("keyUp", mod)),
  ];
}
