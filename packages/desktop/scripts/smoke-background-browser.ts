/**
 * Real-Electron smoke for the unattended browser path.
 *
 * This is intentionally not part of `bun test`: it needs Electron's Chromium.
 * `bun run smoke:background-browser` bundles this entry, launches a hidden
 * BrowserWindow, navigates to a local page, observes its a11y tree, and captures
 * a real CDP screenshot.
 */

import { createServer } from "node:http";
import { app, type WebContents } from "electron";
import { driverFor } from "../src/main/browser-driver/electron-cdp.js";
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
            <input aria-label="Shortcut fixture" value="Sample text" />
            <div style="margin-top:24px;width:320px;height:180px;background:#ff6b35"></div>
          </main>
          <script>
            window.copyEvents = 0;
            document.addEventListener('copy', (event) => {
              // Verify the browser editing command without changing the user's clipboard.
              event.preventDefault();
              window.copyEvents += 1;
            });
          </script>
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
  // Reclamation intentionally closes the only window before this smoke reopens it.
  app.on("window-all-closed", () => undefined);
  await app.whenReady();
  const page = await listen();
  let contents: WebContents | undefined;
  const runtime = new BackgroundBrowserRuntime({
    idleTtlMs: 1_000,
    deps: {
      createDriver: (webContents) => {
        contents = webContents;
        return driverFor(webContents);
      },
    },
  });
  const owner = {
    ownerId: "smoke",
    partition: backgroundBrowserPartition("smoke"),
  };
  let lease = runtime.acquire(owner);
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
    const input = snapshot.elements.find((element) => element.name === "Shortcut fixture");
    if (!input) throw new Error("a11y snapshot did not contain the shortcut input");
    const selected = await lease.bridge.pressKey("ControlOrMeta+a", input.ref);
    const selection = await contents!.executeJavaScript(`(() => {
      const input = document.querySelector('input');
      return { start: input.selectionStart, end: input.selectionEnd, length: input.value.length };
    })()`);
    if (!selected.ok || selection.start !== 0 || selection.end !== selection.length) {
      throw new Error("ControlOrMeta+a did not select the complete input");
    }
    if (process.platform === "darwin") {
      await lease.bridge.pressKey("Control+c");
      if ((await contents!.executeJavaScript("window.copyEvents")) !== 0) {
        throw new Error("literal Control+c was incorrectly converted into a macOS copy command");
      }
    }
    await lease.bridge.pressKey("ControlOrMeta+c");
    if ((await contents!.executeJavaScript("window.copyEvents")) !== 1) {
      throw new Error("ControlOrMeta+c did not trigger the browser copy command");
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

    const [before] = await lease.bridge.listTabs();
    lease.release();
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    lease = runtime.acquire(owner);
    const [closed] = await lease.bridge.listTabs();
    if (closed?.tabId !== before?.tabId || closed?.status !== "closed") {
      throw new Error("idle reclamation did not retain the closed task handle");
    }
    const stale = await lease.bridge.switchTab(before!.tabId);
    if (stale.ok || stale.code !== "TARGET_CLOSED") {
      throw new Error("reclaimed target did not request explicit recovery");
    }
    await lease.bridge.navigate(page.url);
    await lease.bridge.waitForLoad(10_000);
    const recovered = await lease.bridge.snapshot();
    const oldRef = await lease.bridge.click(input.ref);
    if (!oldRef.staleRef || recovered.snapshotId === snapshot.snapshotId) {
      throw new Error("old snapshot refs survived target recreation");
    }
    if ((await lease.bridge.listTabs())[0]?.tabId !== before!.tabId) {
      throw new Error("explicit recovery changed the task's logical tab handle");
    }

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        ok: true,
        url: snapshot.url,
        elements: snapshot.elements.length,
        screenshotBytes: Math.floor((screenshot.base64.length * 3) / 4),
        runtime: runtime.stats(),
        keyboardShortcut: true,
        targetRecovery: true,
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
