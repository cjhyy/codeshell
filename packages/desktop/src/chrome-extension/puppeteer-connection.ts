import {
  connect,
  ExtensionTransport,
} from "puppeteer-core/lib/esm/puppeteer/puppeteer-core-browser.js";
import { PuppeteerBrowserDriver } from "../browser-library/puppeteer-browser-driver.js";
import type { ExtensionConnection } from "./browser-sessions.js";

declare const chrome: any;

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
