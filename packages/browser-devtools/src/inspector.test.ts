import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createBrowserInspector } from "./index.js";

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
    const inspector = createBrowserInspector(page);
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
    const inspector = createBrowserInspector(page);
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
    const a = createBrowserInspector(first);
    const b = createBrowserInspector(second);
    await a.inspect({ mode: "console" });
    await b.inspect({ mode: "console" });
    first.emit("console", { type: () => "log", text: () => "first target" });
    expect((await b.inspect({ mode: "console" })).data).toEqual({ recording: true, entries: [] });
    a.dispose();
    expect(second.listenerCount("console")).toBe(1);
    b.dispose();
  });

  test("only main-document navigation clears recordings when frame identity is available", async () => {
    class FramedPage extends FakePage {
      readonly frame = {};
      mainFrame() {
        return this.frame;
      }
    }

    const page = new FramedPage();
    const inspector = createBrowserInspector(page);
    await inspector.inspect({ mode: "console" });
    await inspector.inspect({ mode: "network" });
    page.emit("console", { type: () => "log", text: () => "current document" });
    page.emit("response", {
      url: () => "https://example.com/resource?token=secret",
      status: () => 200,
      request: () => ({ method: () => "GET", resourceType: () => "fetch" }),
    });

    page.emit("framenavigated", {});
    const unchanged = await inspector.inspect({ mode: "console" });
    expect((unchanged.data as any).entries[0].text).toBe("current document");
    expect(page.listenerCount("response")).toBe(1);

    page.emit("framenavigated", page.frame);
    expect(page.listenerCount("console")).toBe(0);
    expect(page.listenerCount("response")).toBe(0);
    expect((await inspector.inspect({ mode: "console" })).data).toEqual({
      recording: true,
      entries: [],
    });
    expect((await inspector.inspect({ mode: "network" })).data).toEqual({
      recording: true,
      entries: [],
    });
    inspector.dispose();
  });

  test("page closure disposes all listeners and cannot restart recording", async () => {
    const page = new FakePage();
    const inspector = createBrowserInspector(page);
    await inspector.inspect({ mode: "console" });
    await inspector.inspect({ mode: "network" });
    page.emit("close");

    expect(page.eventNames()).toEqual([]);
    expect(await inspector.inspect({ mode: "console" })).toMatchObject({
      ok: false,
      code: "TARGET_CLOSED",
    });
    expect(await inspector.inspect({ mode: "network" })).toMatchObject({
      ok: false,
      code: "TARGET_CLOSED",
    });
    inspector.dispose();
    expect(page.eventNames()).toEqual([]);
  });
});
