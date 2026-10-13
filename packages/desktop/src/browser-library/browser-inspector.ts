import { createBrowserInspector } from "@cjhyy/code-shell-browser-devtools";
import type { Page as PuppeteerPage } from "puppeteer-core/lib/esm/puppeteer/puppeteer-core-browser.js";
import type { Page as PlaywrightPage } from "playwright-core";

export type { BrowserInspector } from "@cjhyy/code-shell-browser-devtools";

// Host adapters keep library-specific types out of the reusable inspector.
// Existing drivers retain their entry points and authorized-page lifecycle.
export const createPuppeteerInspector = (page: PuppeteerPage) => createBrowserInspector(page);
export const createPlaywrightInspector = (page: PlaywrightPage) => createBrowserInspector(page);
