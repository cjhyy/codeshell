import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { createBrowserInspector } from "../../../packages/browser-devtools/src/inspector.js";

class FixtureElement {
  tagName = "DIV";
  children: Iterable<FixtureElement> = [];
  shadowRoot?: { children: Iterable<FixtureElement> };
  childNodes = [{ nodeType: 3, textContent: "ordinary fixture text" }];
  isContentEditable = false;
  constructor(public id: string) {}
  matches() { return false; }
  getAttribute() { return null; }
  getBoundingClientRect() { return { x: 0, y: 0, width: 10, height: 10 }; }
}

function countedCollection(count: number, prefix: string) {
  const counter = { yielded: 0 };
  const collection = {
    length: count,
    *[Symbol.iterator]() {
      for (let i = 0; i < count; i++) {
        counter.yielded++;
        yield new FixtureElement(`${prefix}-${i}`);
      }
    },
  };
  return { counter, collection };
}

class FakePage extends EventEmitter {
  context: Record<string, unknown> = {};
  url() { return "https://fixture.invalid/page"; }
  isClosed() { return false; }
  async evaluate(fn: any, arg?: any) {
    return runInNewContext(`(${fn.toString()})(argument)`, {
      ...this.context, argument: arg, URL,
    });
  }
}

function fixture(root: FixtureElement) {
  const page = new FakePage();
  page.context = {
    document: { querySelector: () => root },
    getComputedStyle: () => ({
      display: "block", visibility: "visible", position: "static", overflow: "visible",
      color: "black", fontSize: "16px", zIndex: "auto",
    }),
    HTMLElement: FixtureElement,
    Node: { TEXT_NODE: 3 },
  };
  return createBrowserInspector(page);
}

test("observed: one-node DOM read exhausts all 20000 light children before queue cap", async () => {
  const root = new FixtureElement("light-root");
  const { counter, collection } = countedCollection(20000, "light");
  root.children = collection;
  const inspector = fixture(root);
  try {
    const result = await inspector.inspect({ mode: "dom", maxEntries: 1 });
    expect(result.ok).toBe(true);
    expect((result.data as any).nodes.map((node: any) => node.id)).toEqual(["light-root"]);
    expect((result.data as any).truncated).toBe(true);
    expect(counter.yielded).toBe(20000);
    console.log(JSON.stringify({ case: "light-children", requestedNodes: 1,
      returnedNodes: (result.data as any).nodes.length, collectionElementsRead: counter.yielded }));
  } finally { inspector.dispose(); }
});

test("observed: one-node DOM read also exhausts all 20000 open-shadow children", async () => {
  const root = new FixtureElement("shadow-root");
  const { counter, collection } = countedCollection(20000, "shadow");
  root.shadowRoot = { children: collection };
  const inspector = fixture(root);
  try {
    const result = await inspector.inspect({ mode: "dom", maxEntries: 1 });
    expect(result.ok).toBe(true);
    expect((result.data as any).nodes).toHaveLength(1);
    expect((result.data as any).truncated).toBe(true);
    expect(counter.yielded).toBe(20000);
    console.log(JSON.stringify({ case: "shadow-children", requestedNodes: 1,
      returnedNodes: (result.data as any).nodes.length, collectionElementsRead: counter.yielded }));
  } finally { inspector.dispose(); }
});

test("control: small complete child collection retains order and reports complete summary", async () => {
  const root = new FixtureElement("small-root");
  const { counter, collection } = countedCollection(4, "child");
  root.children = collection;
  const inspector = fixture(root);
  try {
    const result = await inspector.inspect({ mode: "dom", maxEntries: 10 });
    expect(result.ok).toBe(true);
    expect((result.data as any).nodes.map((node: any) => node.id))
      .toEqual(["small-root", "child-0", "child-1", "child-2", "child-3"]);
    expect((result.data as any).truncated).toBe(false);
    expect(counter.yielded).toBe(4);
  } finally { inspector.dispose(); }
});

test("control: response and failed-request metadata share the recent-record limit", async () => {
  const page = new FakePage();
  const inspector = createBrowserInspector(page);
  try {
    await inspector.inspect({ mode: "network" });
    page.emit("response", {
      url: () => "https://fixture.invalid/ok", status: () => 204,
      request: () => ({ method: () => "POST", resourceType: () => "fetch" }),
    });
    page.emit("requestfailed", {
      url: () => "https://fixture.invalid/failed", method: () => "GET",
      failure: () => ({ errorText: "ordinary fixture failure" }),
    });
    const entries = (await inspector.inspect({ mode: "network", maxEntries: 2 })).data as any;
    expect(entries.entries.map((entry: any) => entry.url))
      .toEqual(["https://fixture.invalid/ok", "https://fixture.invalid/failed"]);
    expect(entries.entries[0]).toMatchObject({ method: "POST", type: "fetch", status: 204 });
    expect(entries.entries[1]).toMatchObject({ method: "GET", error: "ordinary fixture failure" });
    expect(((await inspector.inspect({ mode: "network", maxEntries: 0 })).data as any).entries)
      .toHaveLength(1);
  } finally { inspector.dispose(); }
});

test("control: performance summary retains timing fields and a bounded record count", async () => {
  const page = new FakePage();
  page.context = { performance: {
    timeOrigin: 1234, now: () => 567,
    getEntriesByType: (type: string) => type === "resource" ? Array.from({ length: 120 }, (_, i) => ({
      name: `https://fixture.invalid/${i}.js`, entryType: "resource", startTime: i, duration: i + 1,
    })) : [],
  } };
  const inspector = createBrowserInspector(page);
  try {
    const result = await inspector.inspect({ mode: "performance", maxEntries: 500 });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ timeOrigin: 1234, now: 567, truncated: true });
    expect((result.data as any).entries).toHaveLength(100);
    expect((result.data as any).entries[99])
      .toEqual({ name: "https://fixture.invalid/99.js", type: "resource", startTime: 99, duration: 100 });
  } finally { inspector.dispose(); }
});
