/**
 * Colorizer — a minimal terminal-color interface that core formatters
 * use without depending on chalk directly.
 *
 * UI hosts (TUI, web client, etc.) supply a real implementation. The
 * default NOOP_COLORIZER returns text unchanged, so non-terminal
 * consumers (web, Electron renderer, programmatic SDK use) see clean
 * text without ANSI escape sequences.
 */
export interface Colorizer {
  dim(s: string): string;
  bold(s: string): string;
  red(s: string): string;
  yellow(s: string): string;
  green(s: string): string;
  cyan(s: string): string;
  white(s: string): string;
  /** Composite: bold + cyan, used for section headers. */
  boldCyan(s: string): string;
  /** Composite: bold + white, used for sub-section headers. */
  boldWhite(s: string): string;
}

const identity = (s: string): string => s;

export const NOOP_COLORIZER: Colorizer = {
  dim: identity,
  bold: identity,
  red: identity,
  yellow: identity,
  green: identity,
  cyan: identity,
  white: identity,
  boldCyan: identity,
  boldWhite: identity,
};
