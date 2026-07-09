# @cjhyy/code-shell-cdp

Environment-agnostic **Chrome DevTools Protocol (CDP) browser-action layer** for [`code-shell`](https://github.com/cjhyy/codeshell).

Drives a browser target — `click` / `type` / `select` / `press_key` / `hover` / `scroll` plus raw page observation — through an **injected CDP sender** you provide. No Playwright, no browser launcher, no agent loop, **zero runtime dependencies**. You bring the transport (an Electron `webContents.debugger`, a raw CDP WebSocket, a test stub, …); this package turns high-level actions into the right CDP commands.

## Package status

This workspace package is internal/private and is not published to npm. Use it
through the monorepo workspace or the desktop app integration.

Requires Node ≥ 20.10 and an ESM-capable runtime.

## Concept

`CdpSender` is a **function** — it sends ONE CDP command and resolves its result. You supply it plus a `pageInfo` getter; the `CdpActionsDriver` composes them into semantic actions and a token-bounded page snapshot. Because the sender is injected, the same driver works against Electron's `webContents.debugger`, a raw CDP WebSocket, or a mock in tests — the package itself never opens or owns a browser.

```ts
import { CdpActionsDriver } from "@cjhyy/code-shell-cdp";
import type { CdpSender, PageInfo } from "@cjhyy/code-shell-cdp";

// A CdpSender is just a function: (method, params?, sessionId?) => Promise<any>
const send: CdpSender = (method, params) => myTransport.sendCommand(method, params);
const pageInfo = async (): Promise<PageInfo> => ({ url: await myTransport.currentUrl() });

const driver = new CdpActionsDriver(send, pageInfo);

// Page observation → structured, token-bounded snapshot (each node carries a backendNodeId)
const snap = await driver.snapshot();

// Actions target a CDP backendNodeId (resolve it from the snapshot)
await driver.clickNode(backendNodeId);
await driver.typeNode(backendNodeId, "hello");
await driver.selectOptionNode(backendNodeId, "value");
await driver.pressKey("Enter");          // or "Control+a", etc.
await driver.scroll("down");
await driver.navigate("https://example.com");
```

## What's exported

- `CdpActionsDriver` — the action + observation driver. Methods: `snapshot()`, `clickNode(id)`, `typeNode(id, text)`, `focusNode(id)`, `hoverNode(id)`, `selectOptionNode(id, value)`, `pressKey(spec)`, `scroll(dir, amount?)`, `navigate(url)`, `extractLinks()`, `waitForLoad(timeoutMs?)`.
- `CdpSender` (a function type), `PageInfo` — the transport you implement and the page-info you supply.
- `planKeySequence`, `keyInfo`, `normalizeKey`, `MODIFIER_BITS`, `KeyInfo`, `KeyEvent` — key-sequence helpers for `pressKey`.
- `buildExtractScript`, `cleanPageText`, `CONTENT_CHAR_CAP`, `EXTRACT_LINK_CAP`, `MAX_IMAGE_DIM` — page-extraction utilities and token-bounding caps.

## Where it's used

In `code-shell`'s desktop app, the Electron main process implements `CdpSender` over its `<webview>`'s `webContents.debugger`, and the core engine's `browser_observe` / `browser_act` / `browser_navigate` tools drive this layer. Screenshots are downscaled server-side via CDP's native `clip.scale` (no in-page canvas round-trip).

## Stability

Pre-1.0 — APIs may change between minor versions. See [CHANGELOG.md](https://github.com/cjhyy/codeshell/blob/main/CHANGELOG.md) in the monorepo.

## License

MIT © maki maki.
