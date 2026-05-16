# CodeShell — Terminal Compatibility Matrix

This document is the canonical list of which terminals CodeShell's
`src/render` engine targets, at what support level, and what's known to break.

Support levels:

- **supported** — release blocker if broken; we run the manual scroll checklist
  before tagging a release.
- **best-effort** — known to work but not in the manual matrix; bugs accepted
  but lower priority.
- **unsupported** — no guarantees; bugs closed as wontfix unless a contributor
  provides a fix.

| Terminal                   | Support       | Notes                                                                 | Last verified |
| -------------------------- | ------------- | --------------------------------------------------------------------- | ------------- |
| iTerm2 (macOS)             | supported     | Primary dev terminal. Full alt-screen, mouse, OSC 52, OSC 8 hyperlinks. | 2026-05-16  |
| tmux (over iTerm2 / xterm) | supported     | OSC 52 wrapped in DCS passthrough; bracketed paste; resize correct.    | pending      |
| Ghostty (macOS / Linux)    | supported     | Kitty keyboard protocol used when available.                          | pending       |
| Windows Terminal           | best-effort   | conpty translates most CSI; cursor parking quirks possible.           | pending       |
| Apple Terminal             | best-effort   | No true color in older versions; OSC 8 partial.                       | pending       |
| VS Code integrated terminal| best-effort   | xterm.js host; clipboard via Code's bridge, not OSC 52.               | pending       |
| xterm (literal)            | best-effort   | Baseline target; assumed to work as default branch in `terminal.ts`.  | pending       |
| Cmd.exe (legacy)           | unsupported   | No alt-screen support; not targeted.                                  | n/a           |

## Cross-references

Terminal-specific behavior in code:

- `src/render/terminal.ts` — environment sniffing + capability inference.
- `src/render/termio/osc.ts` — clipboard (OSC 52) sequence emission and tmux
  passthrough wrapping.
- `src/render/parse-keypress.ts` — kitty keyboard + modifyOtherKeys handling.

## Verification

Per terminal, the manual verification consists of:

1. Launch `bun run dev:bigtranscript 1000`.
2. Run the cases in [`render-scroll-checklist.md`](./render-scroll-checklist.md).
3. Confirm copy/paste round-trips (select assistant text, paste into a text
   editor — content matches).
4. Confirm a streaming reply does not corrupt the screen.

Record the date in the table when a terminal is re-verified.
