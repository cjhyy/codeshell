# Render Scroll — Manual Checklist

Run before any commit that touches `ScrollBox`, `useVirtualScroll`, or
`VirtualMessageList`. Setup is the same for every case unless overridden:

    bun run dev:bigtranscript 10000

Quit with Ctrl+C between cases to reset state.

## Cases

### 1. Tail render under load
- Setup: `bun run dev:bigtranscript 10000`
- Action: wait for prompt; do not scroll.
- Expected: first paint within ~1s. Only viewport rows mount; CPU returns to idle.
- Pass criterion: tail visible, prompt responsive, no continuous redraw.

### 2. Wheel scroll
- Setup: 10k transcript loaded.
- Action: scroll wheel up by ~10 ticks; then back down.
- Expected: smooth movement; sticky-bottom re-engages at the bottom.

### 3. PageUp / PageDown
- Setup: 10k transcript loaded.
- Action: PgUp / PgDn repeatedly.
- Expected: viewport jumps by ~one page; no blank frames; position stable.

### 4. Resize while scrolled mid-history
- Setup: 10k transcript loaded; PgUp to ~row 5000.
- Action: shrink terminal height (drag, or `tput`), then grow it.
- Expected: anchor row 5000 stays in view; no jump to top or bottom.

### 5. New-message divider, sticky-bottom on
- Setup: load 100 transcript; scroll to top.
- Action: trigger an assistant streaming reply (or simulate via dev hook).
- Expected: new-message divider appears at the prior bottom; viewport does NOT jump.

### 6. Streaming while scrolled away
- Setup: 10k transcript, scrolled mid-history.
- Action: trigger streaming text in the latest message.
- Expected: history viewport unmoved; only the off-screen latest message updates.

## Reporting

If any case fails, attach:
- the exact `dev:bigtranscript` count used,
- terminal + size,
- a frame timing line from `~/.code-shell/logs/ui-ink/*` if `CODESHELL_RENDER_DEBUG=1` was on.
