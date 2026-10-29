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

- Chrome usually does not expose page content to accessibility: the window state then lists only the toolbar, tabs and menus, with no web area. When that happens, work from the screenshot: click with `x`,`y`, and to type, call `type_text` with the field's `x`,`y` (it clicks there to focus, then types). Do not keep re-reading for elements that are not there.
- When page elements are present, prefer them: write a field with `set_value` on its element (background `type_text` into a page element is refused with `background_unavailable`), then read the window again to confirm.
- A page area that is present but still empty was read before the page finished building it; CodeShell already reads it a second time.
- Never submit a form, send a message or buy anything unless the user asked for that exact step.
- For work that only reads or tests a web page, CodeShell's built-in browser tools (`browser_navigate`, `browser_observe`, `browser_act`) are usually faster than operating this window.
