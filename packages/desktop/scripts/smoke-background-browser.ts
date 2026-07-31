/**
 * Real-Electron smoke for the unattended browser path.
 *
 * This is intentionally not part of `bun test`: it needs Electron's Chromium.
 * `bun run smoke:background-browser` bundles this entry, launches a hidden
 * BrowserWindow, navigates to a local page, observes its a11y tree, and captures
 * a real CDP screenshot.
 */

import { createServer } from "node:http";
import { app } from "electron";
import {
  BackgroundBrowserRuntime,
  backgroundBrowserPartition,
} from "../src/main/browser-driver/background-runtime.js";
import {
  handleBrowserAction,
  type BrowserActionRequest,
} from "../src/main/browser-driver/automation-host.js";

async function listen(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html>
        <head><title>Background Browser Smoke</title></head>
        <body style="margin:0;background:#10233f;color:white;font:24px sans-serif">
          <main style="padding:48px">
            <button aria-label="Background browser ready">Background browser ready</button>
            <div style="margin-top:24px;width:320px;height:180px;background:#ff6b35"></div>
          </main>
        </body>
      </html>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("smoke server has no TCP address");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function main(): Promise<void> {
  await app.whenReady();
  const page = await listen();
  const runtime = new BackgroundBrowserRuntime({ idleTtlMs: 1_000 });
  const lease = runtime.acquire({
    ownerId: "smoke",
    partition: backgroundBrowserPartition("smoke"),
  });
  let panelOpened = false;
  const act = async <T>(request: BrowserActionRequest): Promise<T> =>
    JSON.parse(
      await handleBrowserAction(request, {
        activeGuest: () => null,
        backgroundBridge: lease.bridge,
        policy: () => ({ allowedDomains: [] }),
        openPanel: async () => {
          panelOpened = true;
          return false;
        },
      }),
    ) as T;

  try {
    const navigated = await act<{ ok: boolean; detail?: string }>({
      action: "navigate",
      url: page.url,
    });
    if (!navigated.ok) throw new Error(navigated.detail || "navigation failed");
    const loaded = await act<{ ok: boolean; detail?: string }>({
      action: "waitForLoad",
      timeoutMs: 10_000,
    });
    if (!loaded.ok) throw new Error(loaded.detail || "page did not load");

    const snapshot = await act<Awaited<ReturnType<typeof lease.bridge.snapshot>>>({
      action: "snapshot",
    });
    if (!snapshot.elements.some((element) => element.name === "Background browser ready")) {
      throw new Error("a11y snapshot did not contain the smoke button");
    }

    const screenshot = await act<Awaited<ReturnType<typeof lease.bridge.screenshot>>>({
      action: "screenshot",
    });
    if (
      !screenshot.ok ||
      screenshot.mediaType !== "image/jpeg" ||
      !screenshot.base64 ||
      screenshot.base64.length < 1_000
    ) {
      throw new Error(screenshot.detail || "hidden-window screenshot was empty");
    }
    if (panelOpened) throw new Error("background action unexpectedly opened the browser panel");

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        ok: true,
        url: snapshot.url,
        elements: snapshot.elements.length,
        screenshotBytes: Math.floor((screenshot.base64.length * 3) / 4),
        runtime: runtime.stats(),
      }),
    );
  } finally {
    lease.release();
    runtime.closeAll();
    await page.close();
    app.quit();
  }
}

void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  app.exit(1);
});
