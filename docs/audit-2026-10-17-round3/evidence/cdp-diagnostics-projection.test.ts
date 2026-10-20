import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { createBrowserInspector } from "../../../packages/browser-devtools/src/inspector.js";

class FixtureElement {
  tagName = "DIV";
  children: FixtureElement[] = [];
  shadowRoot?: { children: FixtureElement[] };
  childNodes: Array<{ nodeType: number; textContent: string }> = [];
  isContentEditable = false;
  style = { display: "block", visibility: "visible", position: "static", overflow: "visible", color: "black", fontSize: "16px", zIndex: "auto" };
  constructor(public id: string, text = "") {
    if (text) this.childNodes.push({ nodeType: 3, textContent: text });
  }
  matches(selector: string) { return selector === "input,textarea" && ["INPUT", "TEXTAREA"].includes(this.tagName); }
  getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 30 }; }
  getAttribute(_name: string) { return null; }
}

class FakePage extends EventEmitter {
  context: Record<string, unknown> = {};
  url() { return "about:blank"; }
  isClosed() { return false; }
  async evaluate(fn: any, arg?: any) {
    // Executes the actual inspector callback locally; no browser, DOM engine,
    // network endpoint, CDP transport or Host code is loaded.
    return runInNewContext(`(${fn.toString()})(argument)`, { ...this.context, argument: arg, URL });
  }
}

function domFixture(root: FixtureElement) {
  const page = new FakePage();
  page.context = {
    document: { querySelector: (selector: string) => selector === "#visible-child" ? root.children[0] : root },
    getComputedStyle: (element: FixtureElement) => element.style,
    HTMLElement: FixtureElement,
    Node: { TEXT_NODE: 3 },
  };
  return { page, inspector: createBrowserInspector(page) };
}

test("observed: visibility:hidden ancestor suppresses a visible descendant from DOM summary", async () => {
  const parent = new FixtureElement("hidden-parent");
  parent.style.visibility = "hidden";
  parent.children = [new FixtureElement("visible-child", "Visible message")];
  const { inspector } = domFixture(parent);
  try {
    const byParent = await inspector.inspect({ mode: "dom", selector: "#hidden-parent" });
    expect(byParent.ok).toBe(true);
    expect(byParent.data).toEqual({ nodes: [], truncated: false });
    const byChild = await inspector.inspect({ mode: "dom", selector: "#visible-child" });
    expect((byChild.data as any).nodes.map((node: any) => node.id)).toEqual(["visible-child"]);
    console.log(JSON.stringify({ case: "visibility-override", parentSummary: byParent.data, childSummary: byChild.data }));
  } finally { inspector.dispose(); }
});

test("control: visible ancestor includes the same child", async () => {
  const parent = new FixtureElement("visible-parent");
  parent.children = [new FixtureElement("visible-child", "Visible message")];
  const { inspector } = domFixture(parent);
  try {
    const result = await inspector.inspect({ mode: "dom" });
    expect((result.data as any).nodes.map((node: any) => node.id)).toEqual(["visible-parent", "visible-child"]);
  } finally { inspector.dispose(); }
});

test("control: display:none subtree is intentionally omitted", async () => {
  const parent = new FixtureElement("display-none");
  parent.style.display = "none";
  parent.children = [new FixtureElement("visible-child")];
  const { inspector } = domFixture(parent);
  try { expect((await inspector.inspect({ mode: "dom" })).data).toEqual({ nodes: [], truncated: false }); }
  finally { inspector.dispose(); }
});

test("control: DOM entry limit indicates pending descendants and open shadow roots are traversed", async () => {
  const parent = new FixtureElement("host");
  parent.shadowRoot = { children: [new FixtureElement("shadow-child", "Shadow text")] };
  const { inspector } = domFixture(parent);
  try {
    expect((await inspector.inspect({ mode: "dom", maxEntries: 1 })).data).toMatchObject({ truncated: true });
    const all = await inspector.inspect({ mode: "dom", maxEntries: 5 });
    expect((all.data as any).nodes.map((node: any) => node.id)).toEqual(["host", "shadow-child"]);
    expect((all.data as any).truncated).toBe(false);
  } finally { inspector.dispose(); }
});

test("control: console retains latest 100, clamps reads and bounds message text", async () => {
  const page = new FakePage();
  const inspector = createBrowserInspector(page);
  try {
    await inspector.inspect({ mode: "console" });
    for (let i = 0; i < 105; i++) page.emit("console", { type: () => "log", text: () => `${i}:` + "x".repeat(2000) });
    const result = await inspector.inspect({ mode: "console", maxEntries: 200 });
    const entries = (result.data as any).entries;
    expect(entries).toHaveLength(100);
    expect(entries[0].text.startsWith("5:")).toBe(true);
    expect(entries.at(-1).text.startsWith("104:")).toBe(true);
    expect(entries.every((entry: any) => entry.text.length === 1000)).toBe(true);
    expect(((await inspector.inspect({ mode: "console", maxEntries: 1.9 })).data as any).entries).toHaveLength(1);
    await inspector.inspect({ mode: "stop" });
    expect((await inspector.inspect({ mode: "console" })).data).toEqual({ recording: true, entries: [] });
  } finally { inspector.dispose(); }
});

test("control: performance callback projects bounded navigation, paint and resource summaries", async () => {
  const page = new FakePage();
  page.context = { performance: {
    timeOrigin: 1000, now: () => 55,
    getEntriesByType: (type: string) => type === "navigation"
      ? [{ name: "https://example.invalid/page?x=1", entryType: type, startTime: 0, duration: 20 }]
      : type === "paint"
        ? [{ name: "first-contentful-paint", entryType: type, startTime: 10, duration: 0 }]
        : [{ name: "https://example.invalid/a.js?q=1", entryType: type, startTime: 3, duration: 4 }],
  } };
  const inspector = createBrowserInspector(page);
  try {
    const bounded = (await inspector.inspect({ mode: "performance", maxEntries: 2 })).data as any;
    expect(bounded).toMatchObject({ timeOrigin: 1000, now: 55, truncated: true });
    expect(bounded.entries.map((entry: any) => entry.type)).toEqual(["navigation", "paint"]);
    const full = (await inspector.inspect({ mode: "performance", maxEntries: 3 })).data as any;
    expect(full.entries.map((entry: any) => entry.type)).toEqual(["navigation", "paint", "resource"]);
    expect(full.truncated).toBe(false);
  } finally { inspector.dispose(); }
});
