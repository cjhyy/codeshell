---
id: chrome
bundleIds:
  [
    com.google.Chrome,
    com.google.Chrome.beta,
    com.google.Chrome.canary,
    com.google.chrome.for.testing,
    org.chromium.Chromium,
    com.microsoft.edgemac,
  ]
names: [Google Chrome, Chrome, Google Chrome for Testing, Chromium, Microsoft Edge]
stage:
  perch: title-bar
  keepClear: [text]
---

## Chromium browsers (Chrome, Edge)

- Chrome builds a page's accessibility tree only after something interacts with the page; until then the window state has no web area. To wake it without clicking: take a screenshot, `scroll` down one line and back up one line at the page's centre (`x`,`y`, `by: "line"`, `amount: 1`), then read the window again.
- Chrome pauses a window that other windows cover completely: it builds no page tree and its screenshot goes stale. If the page still has no web area after waking, tell the user the window is hidden and ask them to bring it into view; do not keep retrying.
- With page elements present, write a field with `set_value` on its element and press controls with `click` on their `element_token`, then read again to confirm. Background `type_text` does not reach a page field, and a pixel `click` presses whatever element lies under the point (an empty spot presses the whole page).
- Use screenshot coordinates only for canvas, video or custom-drawn content.
- Never submit a form, send a message or buy anything unless the user asked for that exact step.
- For work that only reads or tests a web page, CodeShell's built-in browser tools (`browser_navigate`, `browser_observe`, `browser_act`) are usually faster.
