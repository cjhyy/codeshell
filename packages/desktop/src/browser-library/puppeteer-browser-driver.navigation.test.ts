import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Page } from "puppeteer-core/lib/esm/puppeteer/puppeteer-core-browser.js";
import { PuppeteerBrowserDriver } from "./puppeteer-browser-driver.js";
import { pageLooksBlank } from "./wait-condition.js";

describe("Puppeteer navigation load state", () => {
  function fixture(load: () => Promise<unknown>, blank?: () => Promise<boolean>) {
    const events = new EventEmitter();
    let url = "about:blank";
    const waits: Array<{ timeout?: number }> = [];
    const page = Object.assign(events, {
      isClosed: () => false,
      url: () => url,
      goto: async (destination: string) => {
        url = destination;
        events.emit("framenavigated");
      },
      waitForFunction: async (_fn: unknown, options: { timeout?: number }) => {
        waits.push(options);
        await load();
        return { dispose: async () => undefined };
      },
      evaluate: async (fn: unknown) =>
        fn === pageLooksBlank
          ? (blank ?? (async () => false))()
          : { width: 800, height: 600, x: 0, y: 0, dpr: 1 },
      screenshot: async () => "AAAA",
    });
    return { driver: new PuppeteerBrowserDriver(page as unknown as Page), waits };
  }

  test("reports a completed load after a bounded wait", async () => {
    const { driver, waits } = fixture(async () => undefined);
    try {
      const result = await driver.navigate("https://example.test/app");
      expect(result).toMatchObject({ ok: true, documentChanged: true, loadState: "complete" });
      expect(waits).toHaveLength(1);
      expect(waits[0]?.timeout).toBe(10_000);
    } finally {
      driver.dispose();
    }
  });

  test("a page whose load event never arrives is navigated but still loading", async () => {
    const { driver } = fixture(async () => {
      throw Object.assign(new Error("Waiting failed: 10000ms exceeded"), { name: "TimeoutError" });
    });
    try {
      const result = await driver.navigate("https://example.test/app");
      expect(result).toMatchObject({ ok: true, documentChanged: true, loadState: "loading" });
    } finally {
      driver.dispose();
    }
  });

  test("a viewport screenshot of an unrendered page is marked blank", async () => {
    for (const [answer, expected] of [
      [async () => true, true],
      [async () => false, false],
      [
        async () => {
          throw new Error("Execution context was destroyed");
        },
        undefined,
      ],
    ] as const) {
      const { driver } = fixture(async () => undefined, answer);
      try {
        const image = await driver.screenshot();
        expect(image.ok).toBe(true);
        expect(image.blank).toBe(expected as boolean | undefined);
      } finally {
        driver.dispose();
      }
    }
  });
});

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
