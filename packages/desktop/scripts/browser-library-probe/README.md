# Puppeteer over existing Electron targets

This directory contains the current production adapter regression and a historical
feasibility probe. The `production` command below tests the real adapter; `probe`
keeps the original investigation reproducible.

The historical `probe` command is an isolated feasibility test, **not a production backend**. It uses the
unmodified, public Puppeteer `ExtensionTransport` and a small **non-official
Electron facade** for `chrome.debugger`. There is no application code import,
default backend change, debugging port, browser download, profile migration, or
connection to a user's browser.

## Production adapter regression

```sh
bun run --cwd packages/desktop/scripts/browser-library-probe production
```

This command bundles the current production `electron-puppeteer.ts` and shared
driver into the temporary directory, then runs only generated pages in isolated
hidden Electron windows. It does not run the desktop application. Unlike the
historical feasibility probe below, this verifies the real default adapter:
two concurrent targets, exact snapshot refs, cross-target rejection, OOPIF
clicks after scrolling, native screenshot corner pixels and size caps,
DevTools takeover, cancellation, explicit resume, old-ref rejection, cookie/
partition/target preservation, hidden windows, and listener cleanup. It uses
the repository's installed dependencies without modifying manifests or locks.

## Run the historical probe

From the repository root, after the normal repository dependency installation:

```sh
bun run --cwd packages/desktop/scripts/browser-library-probe probe
```

The runner creates a temporary directory, copies the probe there, and installs
the exact `puppeteer-core@23.7.1` dependency with Bun. Its lockfile, dependencies,
and fixture profile remain in that printed directory for inspection. No root
package manifest or lockfile is changed. The existing repository Electron
`33.4.11` binary runs the fixture. No user application is launched or reloaded.
Installation is bounded to 120 seconds and the Electron stage to 60 seconds.
Interruptions and timeouts terminate the spawned process group, including
fixture helper processes on macOS/Linux.

The HTTP listener serves generated fixture pages only. `127.0.0.1` and
`localhost` produce a cross-origin iframe with site isolation enabled; the
listener is a fixture website, **not a debugging endpoint**.

## Historical probe boundary

On macOS, Electron 33.4.11 / Node 20.18.3 / Chromium 130.0.6723.191:

- Public `page.locator().fill()`, `page.select()`, and locator clicks work.
- Clicks automatically reveal targets in nested containers and after document
  scrolling beyond 1,000 CSS pixels.
- Cross-origin OOPIF discovery and `frame.locator().click()` work in a normal
  hidden window, including native child-session event routing.
- Both zoom 1 and 1.25 run with forced device scale 2 (DOM DPR 2 and 2.5).
- The same webContents, Electron session/partition, and synthetic login cookie
  survive both operations and disconnect/reconnect. The window stays hidden;
  an unrelated fixture window is never attached.
- `browser.disconnect()` releases the debugger and listeners without closing
  the target. Reconnecting can fill the same input. The probe does not exercise
  an actual DevTools takeover race.

The default command exits nonzero on any failed assertion. This probes ordinary
hidden BrowserWindows, as used by `browser-host`; it does not certify every
embedded webview or the complete production grant lifecycle.

## Offscreen diagnostic

```sh
bun run --cwd packages/desktop/scripts/browser-library-probe probe --offscreen
```

With Electron `offscreen: true`, the OOPIF was discovered and evaluated, but its
mouse click did not reach the child button in the initial investigation. Main
frame actions and reconnect still worked. The diagnostic prints every result
and exits nonzero if either iframe click fails. Ordinary hidden windows passed.
Do not treat hidden windows and Electron offscreen rendering as equivalent.

## Current production integration

The migration is implemented. See the
[production architecture and verification record](../../../../docs/todo/browser-automation-library-reuse.md)
for the current source paths, permissions, rollout requirements and Chrome smoke.

- Electron uses a stable debugger facade with a unique routing token for each
  connection generation, target-scoped child-session routing, cancellation and explicit
  resume. Releasing one target cannot detach another or a later connection.
- Production snapshot refs retain exact `ElementHandle`s across both Puppeteer
  and Playwright. Replaced nodes, navigation and reconnect invalidate old refs;
  the selector-based historical probe is not the production ref implementation.
- Chrome extension 0.2.0 runs official `ExtensionTransport` inside its service
  worker. Native Messaging protocol 2 carries high-level actions with tab/grant
  identity, not `cdp.command` or a custom raw-event proxy. It has a separate real
  native-host smoke covering two tabs, OOPIFs, revocation and disconnect.
- Electron screenshots still use the existing target's `capturePage`; ownership,
  permissions, diagnostic bounds and content-progress interpretation remain host
  responsibilities.

Official `ExtensionTransport` remains experimental. The Electron facade is
maintained by CodeShell and is not an official upstream Electron integration.
Puppeteer 23.7.1 and Electron 33.4.11 are the tested combination. The upstream
synthetic tab-session resume is rejected as an unknown child session and tolerated
by this version; no private session name is hard-coded. Upgrading either library
requires repeating the production regression. The historical offscreen result
above remains a limitation, not a claim that every Electron rendering mode works.

## Official references

- [ConnectionTransport](https://pptr.dev/api/puppeteer.connectiontransport)
- [ExtensionTransport](https://pptr.dev/api/puppeteer.extensiontransport)
- [Official extension guide](https://pptr.dev/guides/running-puppeteer-in-extensions)
- [Versioned ExtensionTransport source](https://github.com/puppeteer/puppeteer/blob/puppeteer-v23.7.1/packages/puppeteer-core/src/cdp/ExtensionTransport.ts)
- [Browser compatibility table](https://pptr.dev/supported-browsers)
- [Electron Debugger API](https://www.electronjs.org/docs/latest/api/debugger)
