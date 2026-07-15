import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type Listener = (event: Event) => void;

class MiniEventTarget {
  private readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: Event): boolean {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return true;
  }
}

class MiniEvent {
  constructor(readonly type: string) {}
}

class MiniNode extends MiniEventTarget {
  childNodes: MiniNode[] = [];
  parentNode: MiniNode | null = null;
  ownerDocument: MiniDocument | null = null;
  nodeType = 1;
  nodeName = "";
  private text = "";

  appendChild<T extends MiniNode>(node: T): T {
    this.childNodes.push(node);
    node.parentNode = this;
    return node;
  }

  insertBefore<T extends MiniNode>(node: T, before: MiniNode | null): T {
    if (!before) return this.appendChild(node);
    const index = this.childNodes.indexOf(before);
    if (index < 0) return this.appendChild(node);
    this.childNodes.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }

  removeChild<T extends MiniNode>(node: T): T {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  set textContent(value: string) {
    this.text = value;
  }

  get textContent(): string {
    return this.text;
  }
}

class MiniElement extends MiniNode {
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  namespaceURI = "http://www.w3.org/1999/xhtml";
  tagName: string;
  private formValue = "";

  constructor(tagName: string, ownerDocument: MiniDocument) {
    super();
    this.ownerDocument = ownerDocument;
    this.tagName = tagName.toUpperCase();
    this.nodeName = this.tagName;
  }

  override appendChild<T extends MiniNode>(node: T): T {
    const appended = super.appendChild(node);
    this.syncSelectOptions();
    return appended;
  }

  override insertBefore<T extends MiniNode>(node: T, before: MiniNode | null): T {
    const inserted = super.insertBefore(node, before);
    this.syncSelectOptions();
    return inserted;
  }

  override removeChild<T extends MiniNode>(node: T): T {
    const removed = super.removeChild(node);
    this.syncSelectOptions();
    return removed;
  }

  get length(): number {
    return this.tagName === "SELECT" ? this.childNodes.length : 0;
  }

  get options(): MiniElement {
    return this;
  }

  get value(): string {
    return this.formValue;
  }

  set value(value: string) {
    this.formValue = value;
  }

  private syncSelectOptions(): void {
    if (this.tagName !== "SELECT") return;
    this.childNodes.forEach((node, index) => {
      (this as unknown as Record<number, MiniNode>)[index] = node;
    });
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  closest(selector: string): MiniElement | null {
    const tagName = selector.toUpperCase();
    let current: MiniNode | null = this;
    while (current) {
      if (current instanceof MiniElement && current.tagName === tagName) return current;
      current = current.parentNode;
    }
    return null;
  }
}

class MiniText extends MiniNode {
  nodeType = 3;
  nodeName = "#text";
  nodeValue: string;
  data: string;

  constructor(text: string, ownerDocument: MiniDocument) {
    super();
    this.ownerDocument = ownerDocument;
    this.nodeValue = text;
    this.data = text;
  }
}

class MiniDocumentFragment extends MiniNode {
  override nodeType = 11;
  override nodeName = "#document-fragment";

  constructor(
    ownerDocument: MiniDocument | null =
      ((globalThis as typeof globalThis & { document?: MiniDocument }).document ?? null),
  ) {
    super();
    this.ownerDocument = ownerDocument;
  }
}

class MiniDocument extends MiniEventTarget {
  readonly nodeType = 9;
  readonly nodeName = "#document";
  defaultView: unknown = null;
  documentElement: MiniElement;
  body: MiniElement;

  constructor() {
    super();
    this.documentElement = new MiniElement("html", this);
    this.body = new MiniElement("body", this);
  }

  createElement(tagName: string): MiniElement {
    return new MiniElement(tagName, this);
  }

  createElementNS(namespaceURI: string, tagName: string): MiniElement {
    const element = new MiniElement(tagName, this);
    element.namespaceURI = namespaceURI;
    return element;
  }

  createTextNode(text: string): MiniText {
    return new MiniText(text, this);
  }

  createDocumentFragment(): MiniDocumentFragment {
    return new MiniDocumentFragment(this);
  }
}

let installed = false;

export function ensureMiniDom(): void {
  if (installed && typeof window !== "undefined" && typeof document !== "undefined") return;

  const doc = new MiniDocument();
  const win = new MiniEventTarget() as MiniEventTarget & Record<string, unknown>;
  win.document = doc;
  win.Event = MiniEvent;
  win.CustomEvent = MiniEvent;
  win.Node = MiniNode;
  win.Element = MiniElement;
  win.HTMLElement = MiniElement;
  win.HTMLSelectElement = MiniElement;
  win.HTMLIFrameElement = class {};
  win.DocumentFragment = MiniDocumentFragment;
  win.SVGElement = MiniElement;
  win.setTimeout = globalThis.setTimeout.bind(globalThis);
  win.clearTimeout = globalThis.clearTimeout.bind(globalThis);
  doc.defaultView = win;

  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    window: win,
    document: doc,
    Event: MiniEvent,
    CustomEvent: MiniEvent,
    Node: MiniNode,
    Element: MiniElement,
    HTMLElement: MiniElement,
    HTMLSelectElement: MiniElement,
    DocumentFragment: MiniDocumentFragment,
    SVGElement: MiniElement,
  });
  installed = true;
}

export async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

export async function renderHook<T>(useHook: () => T): Promise<{
  result: { current: T };
  rerender: () => Promise<void>;
  unmount: () => Promise<void>;
}> {
  ensureMiniDom();
  const result = { current: undefined as T | undefined };
  const container = document.createElement("div");
  let root: Root | null = createRoot(container);

  function Host(): null {
    result.current = useHook();
    return null;
  }

  const render = async () => {
    await act(async () => {
      root?.render(React.createElement(Host));
      await flushMicrotasks();
    });
  };

  await render();

  return {
    result: result as { current: T },
    rerender: render,
    unmount: async () => {
      await act(async () => {
        root?.unmount();
        root = null;
        await flushMicrotasks();
      });
    },
  };
}
