import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
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

describe("DOM summary traversal", () => {
  class FixtureElement {
    tagName = "DIV";
    children: ArrayLike<FixtureElement> = [];
    shadowRoot?: { children: ArrayLike<FixtureElement> };
    childNodes: ArrayLike<{ nodeType: number; textContent: string | null }>;
    isContentEditable = false;
    constructor(
      public id: string,
      public style: { display?: string; visibility?: string } = {},
      text = id,
    ) {
      this.childNodes = [{ nodeType: 3, textContent: text }];
    }
    matches() {
      return false;
    }
    getAttribute() {
      return null;
    }
    getBoundingClientRect() {
      return { x: 0, y: 0, width: 10, height: 10 };
    }
  }

  // Runs the real page-evaluation callback against a minimal DOM in a VM.
  class DomPage extends FakePage {
    constructor(private root: FixtureElement) {
      super();
    }
    override async evaluate(fn: any, arg?: any): Promise<any> {
      return runInNewContext(`(${fn.toString()})(argument)`, {
        argument: arg,
        document: { querySelector: () => this.root },
        getComputedStyle: (element: FixtureElement) => ({
          display: element.style.display ?? "block",
          visibility: element.style.visibility ?? "visible",
          position: "static",
          overflow: "visible",
          color: "black",
          fontSize: "16px",
          zIndex: "auto",
        }),
        HTMLElement: FixtureElement,
        Node: { TEXT_NODE: 3 },
      });
    }
  }

  function countedCollection<T>(items: T[]) {
    const counter = { reads: 0 };
    const collection = new Proxy(items, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) counter.reads++;
        return Reflect.get(target, property, receiver);
      },
    });
    return { counter, collection };
  }

  async function domSummary(root: FixtureElement, maxEntries = 50) {
    const inspector = createBrowserInspector(new DomPage(root));
    try {
      const result = await inspector.inspect({ mode: "dom", maxEntries });
      expect(result.ok).toBe(true);
      return result.data as { nodes: { id: string; text?: string }[]; truncated: boolean };
    } finally {
      inspector.dispose();
    }
  }

  // Regression (CDP-R3-03): visibility:hidden does not hide descendants that
  // set visibility:visible, unlike display:none which removes the subtree.
  test("visibility:hidden ancestor is omitted but its visible descendants are kept", async () => {
    const root = new FixtureElement("hidden-parent", { visibility: "hidden" });
    root.children = [
      new FixtureElement("visible-child"),
      new FixtureElement("hidden-child", { visibility: "hidden" }),
    ];
    const data = await domSummary(root);
    expect(data.nodes.map((node) => node.id)).toEqual(["visible-child"]);
    expect(data.truncated).toBe(false);
  });

  test("display:none still removes the whole subtree", async () => {
    const root = new FixtureElement("none-parent", { display: "none" });
    root.children = [new FixtureElement("visible-child")];
    expect((await domSummary(root)).nodes).toEqual([]);
  });

  test("a hidden editable ancestor still does not expose its descendants", async () => {
    const root = new FixtureElement("editor", { visibility: "hidden" });
    root.isContentEditable = true;
    root.children = [new FixtureElement("draft", {}, "secret draft")];
    expect((await domSummary(root)).nodes).toEqual([]);
  });

  // Regression (DIAG-R10-01): wide child collections were copied in full with
  // Array.from before the queue cap was checked.
  test.each(["light", "shadow"] as const)(
    "wide %s child collections are read only up to the traversal budget",
    async (kind) => {
      const root = new FixtureElement("wide-root");
      const { counter, collection } = countedCollection(
        Array.from({ length: 20000 }, (_, i) => new FixtureElement(`${kind}-${i}`)),
      );
      if (kind === "light") root.children = collection;
      else root.shadowRoot = { children: collection };
      const data = await domSummary(root, 1);
      expect(data.nodes.map((node) => node.id)).toEqual(["wide-root"]);
      expect(data.truncated).toBe(true);
      expect(counter.reads).toBeLessThanOrEqual(1000);
    },
  );

  test("direct text extraction stops reading text nodes once the snippet is full", async () => {
    const root = new FixtureElement("text-root");
    const { counter, collection } = countedCollection(
      Array.from({ length: 20000 }, (_, i) => ({ nodeType: 3, textContent: `t${i}` })),
    );
    root.childNodes = collection;
    const data = await domSummary(root, 1);
    expect(data.nodes[0]!.text).toBe(
      Array.from({ length: 20000 }, (_, i) => `t${i}`)
        .join(" ")
        .slice(0, 160),
    );
    expect(counter.reads).toBeLessThanOrEqual(1000);
  });

  test("small child collections are summarised completely and in order", async () => {
    const root = new FixtureElement("small-root");
    root.children = [0, 1, 2].map((i) => new FixtureElement(`child-${i}`));
    const data = await domSummary(root, 10);
    expect(data.nodes.map((node) => node.id)).toEqual([
      "small-root",
      "child-0",
      "child-1",
      "child-2",
    ]);
    expect(data.truncated).toBe(false);
  });
});
