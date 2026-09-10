import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createPlaywrightInspector } from "./browser-inspector.js";
import type { Page } from "playwright-core";

class FakePage extends EventEmitter {
  url() {
    return "https://example.com/path?token=secret#fragment";
  }
  isClosed() {
    return false;
  }
  async evaluate() {
    return { nodes: [] };
  }
}

describe("bounded developer inspector", () => {
  test("bounds URLs and never returns data URL bodies", async () => {
    const page = new FakePage();
    const inspector = createPlaywrightInspector(page as unknown as Page);
    await inspector.inspect({ mode: "network" });
    for (const url of ["https://example.com/" + "x".repeat(100000), "data:text/html,secret-body"]) {
      page.emit("response", {
        url: () => url,
        status: () => 200,
        request: () => ({ method: () => "GET", resourceType: () => "document" }),
      });
    }
    const result = await inspector.inspect({ mode: "network" });
    expect(JSON.stringify(result).length).toBeLessThan(2000);
    expect(JSON.stringify(result)).not.toContain("secret-body");
    page.emit("framenavigated", {});
    expect(page.listenerCount("response")).toBe(0);
    inspector.dispose();
  });
  test("records only after requested; caps entries, removes queries, stops listeners", async () => {
    const page = new FakePage();
    const inspector = createPlaywrightInspector(page as unknown as Page);
    expect(page.listenerCount("response")).toBe(0);
    await inspector.inspect({ mode: "network" });
    for (let i = 0; i < 120; i++)
      page.emit("response", {
        url: () => `https://example.com/item/${i}?token=secret`,
        status: () => 200,
        request: () => ({ method: () => "GET", resourceType: () => "fetch" }),
      });
    const result = await inspector.inspect({ mode: "network", maxEntries: 1000 });
    expect((result.data as any).entries.length).toBe(100);
    expect(JSON.stringify(result)).not.toContain("secret");
    await inspector.inspect({ mode: "console" });
    page.emit("console", { type: () => "log", text: () => "x".repeat(5000) });
    const logs = await inspector.inspect({ mode: "console" });
    expect((logs.data as any).entries[0].text.length).toBe(1000);
    await inspector.inspect({ mode: "stop" });
    expect(page.listenerCount("response")).toBe(0);
    expect(page.listenerCount("console")).toBe(0);
    expect((await inspector.inspect({ mode: "console" })).data).toEqual({
      recording: true,
      entries: [],
    });
    inspector.dispose();
    expect((await inspector.inspect({ mode: "console" })).code).toBe("TARGET_CLOSED");
    expect(page.eventNames()).toEqual([]);
  });

  test("different targets cannot share logs", async () => {
    const first = new FakePage();
    const second = new FakePage();
    const a = createPlaywrightInspector(first as unknown as Page);
    const b = createPlaywrightInspector(second as unknown as Page);
    await a.inspect({ mode: "console" });
    await b.inspect({ mode: "console" });
    first.emit("console", { type: () => "log", text: () => "first target" });
    expect((await b.inspect({ mode: "console" })).data).toEqual({ recording: true, entries: [] });
    a.dispose();
    expect(second.listenerCount("console")).toBe(1);
    b.dispose();
  });
});
