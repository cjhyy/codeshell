/**
 * Vim mode — vim keybinding layer for the text input.
 *
 * Supports Normal, Insert, and Visual modes with basic vim motions.
 */

export type VimMode = "normal" | "insert" | "visual" | "command";

export interface VimState {
  mode: VimMode;
  cursor: number;
  commandBuffer: string;
  visualStart: number;
  register: string;
}

export function createVimState(): VimState {
  return {
    mode: "insert", // Start in insert mode (like default editor)
    cursor: 0,
    commandBuffer: "",
    visualStart: 0,
    register: "",
  };
}

export interface VimResult {
  state: VimState;
  text: string;
  consumed: boolean;
  action?: "submit" | "command";
  commandText?: string;
}

/**
 * Process a key press in vim mode.
 */
export function processVimKey(
  key: string,
  char: string,
  text: string,
  state: VimState,
): VimResult {
  const s = { ...state };

  // ESC always goes to normal mode
  if (key === "escape") {
    s.mode = "normal";
    s.commandBuffer = "";
    return { state: s, text, consumed: true };
  }

  if (s.mode === "insert") {
    // In insert mode, pass through to TextInput (not consumed)
    return { state: s, text, consumed: false };
  }

  if (s.mode === "command") {
    return handleCommandMode(char, key, text, s);
  }

  if (s.mode === "normal") {
    return handleNormalMode(char, key, text, s);
  }

  if (s.mode === "visual") {
    return handleVisualMode(char, key, text, s);
  }

  return { state: s, text, consumed: false };
}

function handleNormalMode(char: string, key: string, text: string, s: VimState): VimResult {
  switch (char) {
    // Mode changes
    case "i":
      s.mode = "insert";
      return { state: s, text, consumed: true };
    case "a":
      s.mode = "insert";
      s.cursor = Math.min(s.cursor + 1, text.length);
      return { state: s, text, consumed: true };
    case "A":
      s.mode = "insert";
      s.cursor = text.length;
      return { state: s, text, consumed: true };
    case "I":
      s.mode = "insert";
      s.cursor = 0;
      return { state: s, text, consumed: true };
    case "o":
      s.mode = "insert";
      return { state: s, text: text + "\n", consumed: true };
    case "v":
      s.mode = "visual";
      s.visualStart = s.cursor;
      return { state: s, text, consumed: true };
    case ":":
      s.mode = "command";
      s.commandBuffer = "";
      return { state: s, text, consumed: true };

    // Navigation
    case "h":
      s.cursor = Math.max(0, s.cursor - 1);
      return { state: s, text, consumed: true };
    case "l":
      s.cursor = Math.min(text.length - 1, s.cursor + 1);
      return { state: s, text, consumed: true };
    case "0":
      s.cursor = 0;
      return { state: s, text, consumed: true };
    case "$":
      s.cursor = Math.max(0, text.length - 1);
      return { state: s, text, consumed: true };
    case "w":
      s.cursor = nextWordStart(text, s.cursor);
      return { state: s, text, consumed: true };
    case "b":
      s.cursor = prevWordStart(text, s.cursor);
      return { state: s, text, consumed: true };
    case "e":
      s.cursor = nextWordEnd(text, s.cursor);
      return { state: s, text, consumed: true };

    // Editing
    case "x":
      if (s.cursor < text.length) {
        text = text.slice(0, s.cursor) + text.slice(s.cursor + 1);
      }
      return { state: s, text, consumed: true };
    case "d":
      // dd = clear line (simplified)
      s.register = text;
      text = "";
      s.cursor = 0;
      return { state: s, text, consumed: true };
    case "p":
      text = text.slice(0, s.cursor + 1) + s.register + text.slice(s.cursor + 1);
      return { state: s, text, consumed: true };
    case "u":
      // Undo not supported in simple mode
      return { state: s, text, consumed: true };

    default:
      return { state: s, text, consumed: true };
  }
}

function handleVisualMode(char: string, _key: string, text: string, s: VimState): VimResult {
  switch (char) {
    case "d":
    case "x": {
      const start = Math.min(s.visualStart, s.cursor);
      const end = Math.max(s.visualStart, s.cursor) + 1;
      s.register = text.slice(start, end);
      text = text.slice(0, start) + text.slice(end);
      s.cursor = start;
      s.mode = "normal";
      return { state: s, text, consumed: true };
    }
    case "y": {
      const start = Math.min(s.visualStart, s.cursor);
      const end = Math.max(s.visualStart, s.cursor) + 1;
      s.register = text.slice(start, end);
      s.mode = "normal";
      return { state: s, text, consumed: true };
    }
    // Navigation (same as normal)
    case "h":
      s.cursor = Math.max(0, s.cursor - 1);
      return { state: s, text, consumed: true };
    case "l":
      s.cursor = Math.min(text.length - 1, s.cursor + 1);
      return { state: s, text, consumed: true };
    case "w":
      s.cursor = nextWordStart(text, s.cursor);
      return { state: s, text, consumed: true };
    case "b":
      s.cursor = prevWordStart(text, s.cursor);
      return { state: s, text, consumed: true };
    default:
      s.mode = "normal";
      return { state: s, text, consumed: true };
  }
}

function handleCommandMode(char: string, key: string, text: string, s: VimState): VimResult {
  if (key === "return") {
    const cmd = s.commandBuffer.trim();
    s.mode = "normal";
    s.commandBuffer = "";
    if (cmd === "q" || cmd === "quit") {
      return { state: s, text, consumed: true, action: "command", commandText: "/exit" };
    }
    if (cmd.startsWith("w")) {
      return { state: s, text, consumed: true, action: "command", commandText: "/commit" };
    }
    // Treat as slash command
    return { state: s, text, consumed: true, action: "command", commandText: `/${cmd}` };
  }
  if (key === "backspace") {
    s.commandBuffer = s.commandBuffer.slice(0, -1);
    return { state: s, text, consumed: true };
  }
  s.commandBuffer += char;
  return { state: s, text, consumed: true };
}

// ─── Word motion helpers ────────────────────────────────────────

function nextWordStart(text: string, pos: number): number {
  let i = pos + 1;
  while (i < text.length && /\w/.test(text[i])) i++;
  while (i < text.length && /\W/.test(text[i])) i++;
  return Math.min(i, text.length - 1);
}

function prevWordStart(text: string, pos: number): number {
  let i = pos - 1;
  while (i > 0 && /\W/.test(text[i])) i--;
  while (i > 0 && /\w/.test(text[i - 1])) i--;
  return Math.max(i, 0);
}

function nextWordEnd(text: string, pos: number): number {
  let i = pos + 1;
  while (i < text.length && /\W/.test(text[i])) i++;
  while (i < text.length && /\w/.test(text[i])) i++;
  return Math.min(i - 1, text.length - 1);
}
