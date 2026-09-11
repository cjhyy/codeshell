import { describe, expect, mock, test } from "bun:test";
import type { Page } from "puppeteer-core/lib/esm/puppeteer/puppeteer-core-browser.js";
import { PuppeteerBrowserDriver } from "./puppeteer-browser-driver.js";

describe("Puppeteer observation handle cleanup", () => {
  function fixture() {
    const node = (element: boolean) => {
      const handle = {
        dispose: mock(async () => {}),
        asElement: mock<() => unknown>(() => null),
      };
      if (element) handle.asElement.mockReturnValue(handle);
      return handle;
    };
    const first = node(true);
    const ignored = node(false);
    const last = node(true);
    const nodes = {
      dispose: mock(async () => {}),
      getProperties: mock(
        async () =>
          new Map([
            ["0", first],
            ["1", ignored],
            ["2", last],
          ]),
      ),
    };
    const metadata = {
      dispose: mock(async () => {}),
      jsonValue: mock(async () => [
        { role: "button", name: "First" },
        { role: "button", name: "Ignored" },
        { role: "button", name: "Last" },
      ]),
    };
    const result = {
      dispose: mock(async () => {}),
      getProperty: mock(
        async (key: string): Promise<unknown> => (key === "nodes" ? nodes : metadata),
      ),
      evaluate: mock(async () => false),
    };
    const driver = new PuppeteerBrowserDriver({
      on() {},
      off() {},
      isClosed: () => false,
      url: () => "https://example.test/cleanup",
      title: async () => "Cleanup fixture",
      frames: () => [{ evaluateHandle: async () => result }],
    } as unknown as Page);
    return { driver, result, nodes, metadata, first, ignored, last };
  }

  for (const property of ["nodes", "metadata"]) {
    test(`releases acquired handles when ${property} lookup rejects`, async () => {
      const f = fixture();
      f.result.getProperty.mockImplementation(async (key) => {
        if (key === property) throw new Error(`${property} lookup failed`);
        return f.nodes;
      });
      f.result.dispose.mockRejectedValue(new Error("result cleanup failed"));
      f.nodes.dispose.mockRejectedValue(new Error("nodes cleanup failed"));
      try {
        const snapshot = await f.driver.snapshot();
        expect(snapshot.elements).toEqual([]);
        expect(snapshot.detail).toBe(`${property} lookup failed`);
        expect(f.result.dispose).toHaveBeenCalledTimes(1);
        expect(f.nodes.dispose).toHaveBeenCalledTimes(property === "metadata" ? 1 : 0);
        expect(f.metadata.dispose).not.toHaveBeenCalled();
      } finally {
        f.driver.dispose();
      }
    });
  }

  for (const synchronous of [false, true]) {
    test(`preserves observation failure when cleanup ${synchronous ? "throws" : "rejects"}`, async () => {
      const f = fixture();
      f.metadata.jsonValue.mockRejectedValue(new Error("metadata read failed"));
      const cleanup = () => {
        const error = new Error("cleanup failed");
        if (synchronous) throw error;
        return Promise.reject(error);
      };
      for (const handle of [f.result, f.nodes, f.metadata])
        handle.dispose.mockImplementation(cleanup);
      try {
        const snapshot = await f.driver.snapshot();
        expect(snapshot.detail).toBe("metadata read failed");
        for (const handle of [f.result, f.nodes, f.metadata]) {
          expect(handle.dispose).toHaveBeenCalledTimes(1);
        }
      } finally {
        f.driver.dispose();
      }
    });
  }

  test("continues cleanup after an ignored handle rejects without disposing retained refs", async () => {
    const f = fixture();
    f.ignored.dispose.mockRejectedValue(new Error("ignored handle cleanup failed"));
    try {
      const snapshot = await f.driver.snapshot();
      expect(snapshot.detail).toBeUndefined();
      expect(snapshot.elements.map((element) => element.name)).toEqual(["First", "Last"]);
      for (const handle of [f.result, f.nodes, f.metadata, f.ignored]) {
        expect(handle.dispose).toHaveBeenCalledTimes(1);
      }
      expect(f.first.dispose).not.toHaveBeenCalled();
      expect(f.last.dispose).not.toHaveBeenCalled();
    } finally {
      f.driver.dispose();
    }
    expect(f.first.dispose).toHaveBeenCalledTimes(1);
    expect(f.last.dispose).toHaveBeenCalledTimes(1);
  });

  test("releases retained and unclaimed handles after node conversion fails", async () => {
    const f = fixture();
    f.ignored.asElement.mockImplementation(() => {
      throw new Error("node conversion failed");
    });
    f.ignored.dispose.mockRejectedValue(new Error("ignored handle cleanup failed"));
    try {
      const snapshot = await f.driver.snapshot();
      expect(snapshot.elements).toEqual([]);
      expect(snapshot.detail).toBe("node conversion failed");
      for (const handle of [f.result, f.nodes, f.metadata, f.first, f.ignored, f.last]) {
        expect(handle.dispose).toHaveBeenCalledTimes(1);
      }
    } finally {
      f.driver.dispose();
    }
    expect(f.first.dispose).toHaveBeenCalledTimes(1);
  });
});
