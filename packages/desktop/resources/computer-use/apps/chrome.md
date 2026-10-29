---
id: chrome
bundleIds: [com.google.Chrome, com.google.Chrome.beta, com.google.Chrome.canary, com.google.chrome.for.testing, org.chromium.Chromium, com.microsoft.edgemac]
names: [Google Chrome, Chrome, Google Chrome for Testing, Chromium, Microsoft Edge]
stage:
  perch: title-bar
  keepClear: [text]
---
## Chromium browsers (Chrome, Edge)

- Page fields are web content: background `type_text` into them is refused (`background_unavailable`). Write a field with `set_value` on its element, then read the window again to confirm the value.
- Right after a page loads or changes, the page's accessibility tree can be sparse. CodeShell already reads an empty page area a second time; if it is still empty, wait briefly and read again before falling back to screenshot coordinates.
- Prefer element tokens over pixel coordinates. Use coordinates only for content without accessible elements, such as a canvas or video.
- Never submit a form, send a message or buy anything unless the user asked for that exact step.
- For work that only reads or tests a web page, CodeShell's built-in browser tools (`browser_navigate`, `browser_observe`, `browser_act`) are usually faster than operating this window.
