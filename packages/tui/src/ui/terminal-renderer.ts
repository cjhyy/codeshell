/**
 * TerminalRenderer — line-level diff renderer inspired by Claude Code's approach.
 *
 * Instead of relying on Ink's full-redraw or broken incrementalRendering,
 * we maintain two string-array buffers (front/back) and only write changed
 * lines to stdout using absolute cursor positioning (CSI <row>;1H).
 *
 * Key design from CC:
 * - Double-buffered: frontLines (what's on screen) vs backLines (previous)
 * - Alt-screen: CSI ?1049h — no scrollback, cursor always addressable
 * - Atomic writes: BSU/ESU (DEC 2026) wrapping when supported
 * - Damage tracking: only diff the region that changed
 */

// DEC private modes and CSI sequences
const ENTER_ALT_SCREEN = "\x1b[?1049h";
const EXIT_ALT_SCREEN = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CURSOR_HOME = "\x1b[H";
const ERASE_SCREEN = "\x1b[2J";
const DISABLE_BRACKETED_PASTE = "\x1b[?2004l";
const ENABLE_BRACKETED_PASTE = "\x1b[?2004h";
// Begin/End Synchronized Update (DEC 2026) — prevents flicker in modern terminals
const BSU = "\x1b[?2026h";
const ESU = "\x1b[?2026l";

function cursorTo(row: number, col: number): string {
  return `\x1b[${row + 1};${col + 1}H`;
}

function eraseLine(): string {
  return "\x1b[2K";
}

export class TerminalRenderer {
  private frontLines: string[] = [];
  private stdout: NodeJS.WriteStream;
  private rows: number;
  private cols: number;
  private syncSupported: boolean;

  constructor(stdout: NodeJS.WriteStream) {
    this.stdout = stdout;
    this.rows = stdout.rows ?? 24;
    this.cols = stdout.columns ?? 80;
    this.syncSupported = this.detectSyncSupport();

    // Listen for resize
    stdout.on("resize", () => {
      this.rows = stdout.rows ?? 24;
      this.cols = stdout.columns ?? 80;
      // Force full repaint on resize
      this.frontLines = [];
    });
  }

  /** Enter alt screen, hide cursor, clear. */
  enter(): void {
    if (!this.stdout.isTTY) return;
    this.stdout.write(
      ENTER_ALT_SCREEN +
      DISABLE_BRACKETED_PASTE +
      HIDE_CURSOR +
      ERASE_SCREEN +
      CURSOR_HOME,
    );
  }

  /** Exit alt screen, show cursor, restore bracketed paste. */
  exit(): void {
    if (!this.stdout.isTTY) return;
    this.stdout.write(
      SHOW_CURSOR +
      ENABLE_BRACKETED_PASTE +
      EXIT_ALT_SCREEN,
    );
  }

  /**
   * Render a new frame. Takes an array of pre-formatted lines.
   * Only writes lines that differ from the previous frame.
   */
  render(lines: string[]): void {
    if (!this.stdout.isTTY) {
      // Non-TTY fallback: just write everything
      this.stdout.write(lines.join("\n") + "\n");
      return;
    }

    const patches: string[] = [];
    const maxRow = Math.max(lines.length, this.frontLines.length);

    for (let row = 0; row < maxRow; row++) {
      const next = lines[row] ?? "";
      const prev = this.frontLines[row] ?? "";

      if (next !== prev) {
        // Move cursor to this row, erase it, write new content
        patches.push(cursorTo(row, 0) + eraseLine() + next);
      }
    }

    if (patches.length === 0) return;

    // Atomic write: wrap in BSU/ESU if supported, single write() call
    const payload = this.syncSupported
      ? BSU + patches.join("") + ESU
      : patches.join("");

    this.stdout.write(payload);
    this.frontLines = [...lines];
  }

  /**
   * Force a full repaint — clears front buffer so next render() rewrites everything.
   */
  invalidate(): void {
    this.frontLines = [];
  }

  /** Get terminal dimensions. */
  getSize(): { rows: number; cols: number } {
    return { rows: this.rows, cols: this.cols };
  }

  /**
   * Detect if the terminal supports DEC 2026 (Synchronized Update).
   * Most modern terminals do: kitty, iTerm2, WezTerm, Windows Terminal.
   * tmux and older xterm don't.
   */
  private detectSyncSupport(): boolean {
    const term = process.env.TERM_PROGRAM ?? "";
    const termEnv = process.env.TERM ?? "";
    // Known good: kitty, iTerm, WezTerm, Windows Terminal, foot, ghostty
    if (/kitty|iTerm|WezTerm|Windows_Terminal|foot|ghostty/i.test(term)) return true;
    // tmux doesn't support it well
    if (termEnv.startsWith("tmux") || termEnv.startsWith("screen")) return false;
    // xterm-256color in modern terminals usually supports it
    if (termEnv.includes("256color")) return true;
    return false;
  }
}
