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

- Chrome builds a page's accessibility tree only after something interacts with the page. Until then the window state lists only the toolbar, tabs and menus, with no web area. To wake it without clicking anything: take a screenshot, `scroll` down one line and back up one line at the page's centre (`x`,`y`, `by: "line"`, `amount: 1`), then read the window again. The page's fields, buttons and links then appear with element tokens.
- Once page elements are present, use them: write a field with `set_value` on its element and press controls with `click` on their `element_token`, then read the window again to confirm. Background `type_text` does not reach a page field, and a pixel `click` on the page is pressed through accessibility on whatever element lies under the point, so an empty spot presses the whole page.
- Fall back to screenshot coordinates only for canvas, video or custom-drawn content that has no element.
- A page area that is present but still empty was read before the page finished building it; CodeShell already reads it a second time.
- Never submit a form, send a message or buy anything unless the user asked for that exact step.
- For work that only reads or tests a web page, CodeShell's built-in browser tools (`browser_navigate`, `browser_observe`, `browser_act`) are usually faster than operating this window.
