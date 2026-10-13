# Browser DevTools diagnostics

`@cjhyy/code-shell-browser-devtools` is a private, zero-runtime-dependency module
for bounded browser diagnostics. It accepts an injected page surface compatible
with Puppeteer and Playwright. It does not import either library, Electron, or
CodeShell Core.

```ts
import { createBrowserInspector } from "@cjhyy/code-shell-browser-devtools";

// The host resolves and authorizes this exact page before passing it here.
const inspector = createBrowserInspector(page);

await inspector.inspect({ mode: "network" });
// Reproduce the issue on the same document, then read recent records.
const network = await inspector.inspect({ mode: "network", maxEntries: 25 });
const dom = await inspector.inspect({ mode: "dom", selector: "main" });

// Stop and clear recordings, or dispose when releasing the page.
await inspector.inspect({ mode: "stop" });
inspector.dispose();
```

The exported `BrowserInspectorPage` contract contains only URL/closed-state
queries, optional main-frame identity, page evaluation, and event subscription.
The host owns target selection, browser transport, task grants, domain policy,
tool permissions, manual takeover, and any visible Console/Network UI. Inspecting
a page does not authorize access to it. The host must dispose the inspector when
control is revoked.

Supported modes preserve the existing Desktop inspector behavior:

- `console`: starts recording console messages and page errors on first use;
  subsequent calls return recent records.
- `network`: starts recording response and failed-request metadata. It omits
  headers and bodies and strips query strings/fragments from valid HTTP(S) URLs.
- `dom`: returns a bounded subtree summary of tags, direct text, geometry, and
  selected styles. It skips input/editable content and script/style nodes, and
  traverses open shadow roots.
- `performance`: returns bounded navigation, paint, and resource timing summaries.
- `stop`: removes recording listeners and clears console/network history.

Each recorder retains at most 100 entries; reads default to 50 and clamp requested
limits to 1–100. DOM traversal and page-evaluation waits are bounded. Main-document
navigation stops and clears recordings; start recording again on the new
document. When the page port omits `mainFrame`, every frame-navigation event
clears recordings. Page closure disposes the inspector, and disposal is safe to
repeat.

This is a diagnostics summary API, not a complete DevTools frontend. It has no
JavaScript console execution API, debugger/breakpoints, request/response bodies,
HAR export, network interception, browser launcher, or cross-frame DOM selector
API. Console messages and visible DOM text can still contain sensitive or
untrusted page content; consumers remain responsible for handling that output.
Extracting this module does not change whether native DevTools and browser
automation can share a host's debugging connection.
