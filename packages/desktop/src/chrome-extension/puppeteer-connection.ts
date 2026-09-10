import {
  connect,
  ExtensionTransport,
  type Frame,
  type Page,
} from "puppeteer-core/lib/esm/puppeteer/puppeteer-core-browser.js";
import { PuppeteerBrowserDriver } from "../browser-library/puppeteer-browser-driver.js";
import type { ExtensionConnection } from "./browser-sessions.js";

declare const chrome: any;

/** Existing OOPIF targets arrive after browser.pages(); observe their DOM owners
 * through Puppeteer's public APIs so the first snapshot includes them too. */
async function waitForExistingFrames(page: Page, isActive: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  const pending: Frame[] = [page.mainFrame()];
  const visited = new Set<Frame>();
  while (pending.length) {
    if (!isActive()) throw new Error("browser control lease has ended");
    if (Date.now() >= deadline) throw new Error("existing browser frames did not become ready");
    const frame = pending.shift()!;
    if (visited.has(frame)) continue;
    visited.add(frame);
    await frame.evaluate(() => undefined);
    const owners = await frame.$$("iframe,frame");
    try {
      for (const owner of owners) {
        if (!isActive()) throw new Error("browser control lease has ended");
        const child =
          (await owner.contentFrame()) ??
          (await page.waitForFrame(
            async (candidate) => candidate === (await owner.contentFrame()),
            { timeout: Math.max(1, deadline - Date.now()) },
          ));
        pending.push(child);
      }
    } finally {
      await Promise.all(owners.map((owner) => owner.dispose().catch(() => undefined)));
    }
  }
}

/** The official transport owns all debugger commands, events, and child-frame routing. */
export async function connectGrantedTab(
  tabId: number,
  namespace: string,
  isActive: () => boolean,
): Promise<ExtensionConnection> {
  const transport = await ExtensionTransport.connectTab(tabId);
  try {
    const browser = await connect({ transport, defaultViewport: null, protocolTimeout: 10_000 });
    const pages = await browser.pages();
    if (pages.length !== 1) {
      await browser.disconnect();
      throw new Error("authorized Chrome tab did not resolve to one page");
    }
    await waitForExistingFrames(pages[0], isActive);
    const driver = new PuppeteerBrowserDriver(pages[0], {
      documentNamespace: namespace,
      actionTimeoutMs: 10_000,
      isActive,
      identity: {
        profileId: `chrome-tab:${tabId}`,
        sourceKind: "attached-chrome",
        isUserBrowser: true,
      },
    });
    return {
      driver,
      disconnect: async () => {
        await browser.disconnect();
        // The official transport initiates detach without awaiting it; Chrome
        // does not emit onDetach for an extension's own detach. Drain that
        // lifecycle operation before an explicit resume can attach again.
        await chrome.debugger.detach({ tabId }).catch(() => undefined);
      },
    };
  } catch (error) {
    transport.close();
    // Also drain failed initialization before the next grant can attach.
    await chrome.debugger.detach({ tabId }).catch(() => undefined);
    throw error;
  }
}
