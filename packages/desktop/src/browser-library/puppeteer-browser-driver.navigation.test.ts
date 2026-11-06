import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Page } from "puppeteer-core/lib/esm/puppeteer/puppeteer-core-browser.js";
import { PuppeteerBrowserDriver } from "./puppeteer-browser-driver.js";

describe("Puppeteer navigation errors", () => {
  function fixture(error: Error, changesDocument = true) {
    const events = new EventEmitter();
    let url = "about:blank";
    const page = Object.assign(events, {
      isClosed: () => false,
      url: () => url,
      goto: async (destination: string) => {
        if (changesDocument) {
          url = destination;
          events.emit("framenavigated");
        }
        throw error;
      },
    });
    const driver = new PuppeteerBrowserDriver(page as unknown as Page);
    return { driver, page };
  }

  for (const { error, code } of [
    {
      error: Object.assign(new Error("Navigation timeout of 30000 ms exceeded"), {
        name: "TimeoutError",
      }),
      code: "TIMEOUT",
    },
    { error: new Error("net::ERR_CONNECTION_RESET"), code: "FAILED" },
  ]) {
    test(`preserves ${code} after the destination document has changed`, async () => {
      const { driver, page } = fixture(error);
      const before = driver.currentPageInfo().documentId;
      try {
        const result = await driver.navigate("https://example.test/destination");
        expect(result).toMatchObject({
          ok: false,
          code,
          documentChanged: true,
          documentId: driver.currentPageInfo().documentId,
        });
        expect(result.documentId).not.toBe(before);
        expect(result.detail).toContain(error.message);
        expect(result.detail).toContain("observe the new document");
        expect(page.url()).toBe("https://example.test/destination");
      } finally {
        driver.dispose();
      }
    });
  }

  test("does not claim a new document when navigation failed before it changed", async () => {
    const error = new Error("net::ERR_NAME_NOT_RESOLVED");
    const { driver } = fixture(error, false);
    const before = driver.currentPageInfo().documentId;
    try {
      const result = await driver.navigate("https://example.test/destination");
      expect(result).toMatchObject({
        ok: false,
        code: "FAILED",
        detail: error.message,
        documentId: before,
      });
      expect(result.documentChanged).toBeUndefined();
      expect(driver.currentPageInfo().url).toBe("about:blank");
    } finally {
      driver.dispose();
    }
  });

  test("retains target closure rather than suggesting observation of a closed page", async () => {
    const error = new Error("Target closed");
    const { driver, page } = fixture(error);
    page.goto = async () => {
      page.isClosed = () => true;
      page.emit("close");
      throw error;
    };
    try {
      const result = await driver.navigate("https://example.test/destination");
      expect(result).toMatchObject({ ok: false, code: "TARGET_CLOSED", retryable: false });
      expect(result.documentChanged).toBeUndefined();
      expect(result.detail).not.toContain("observe");
    } finally {
      driver.dispose();
    }
  });
});
