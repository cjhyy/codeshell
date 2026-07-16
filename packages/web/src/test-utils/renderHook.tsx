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
  readonly detail: unknown;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  defaultPrevented = false;

  constructor(
    readonly type: string,
    init?: { detail?: unknown; bubbles?: boolean; cancelable?: boolean },
  ) {
    this.detail = init?.detail;
    this.bubbles = init?.bubbles ?? false;
    this.cancelable = init?.cancelable ?? false;
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopPropagation(): void {}
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

  /** Element children only (aria-hidden walks `parent.children` deeply).
   *  Detected by tagName presence, not instanceof — see closest() note. */
  get children(): MiniNode[] {
    return this.childNodes.filter(
      (node) => typeof (node as { tagName?: unknown }).tagName === "string",
    );
  }

  contains(other: unknown): boolean {
    let current = other as MiniNode | null;
    while (current) {
      if (current === this) return true;
      current = current.parentNode ?? null;
    }
    return false;
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
  private checkedValue = false;

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

  get checked(): boolean {
    return this.checkedValue;
  }

  set checked(value: boolean) {
    this.checkedValue = value;
  }

  // Focus management no-ops (Radix FocusScope focuses the dialog content).
  tabIndex = -1;
  focus(_options?: unknown): void {
    const doc = this.ownerDocument as MiniDocument | null;
    if (doc) doc.activeElement = this;
  }
  blur(): void {}

  private syncSelectOptions(): void {
    if (this.tagName !== "SELECT") return;
    this.childNodes.forEach((node, index) => {
      (this as unknown as Record<number, MiniNode>)[index] = node;
    });
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  insertAdjacentElement(position: string, element: MiniElement): MiniElement | null {
    switch (position) {
      case "afterbegin":
        return this.insertBefore(element, this.childNodes[0] ?? null);
      case "beforeend":
        return this.appendChild(element);
      case "beforebegin":
        return this.parentNode ? this.parentNode.insertBefore(element, this) : null;
      case "afterend": {
        if (!this.parentNode) return null;
        const next = this.parentNode.childNodes[this.parentNode.childNodes.indexOf(this) + 1];
        return this.parentNode.insertBefore(element, next ?? null);
      }
      default:
        return null;
    }
  }

  // Selector queries: enough for libraries that scan-and-filter (aria-hidden's
  // `querySelectorAll("[aria-live], script")`, focus scopes). An empty result
  // is a safe answer for the selectors our tests exercise.
  querySelectorAll(_selector: string): MiniElement[] {
    return [];
  }

  querySelector(_selector: string): MiniElement | null {
    return null;
  }

  closest(selector: string): MiniElement | null {
    const tagName = selector.toUpperCase();
    // Check self by tagName (not instanceof): when web and desktop test suites
    // load their own copy of this module in one bun process, elements created
    // by the other copy fail `instanceof MiniElement` and self would be missed.
    if (this.tagName === tagName) return this;
    let current: MiniNode | null = this.parentNode;
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
  head: MiniElement;
  body: MiniElement;
  activeElement: MiniElement | null = null;

  constructor() {
    super();
    this.documentElement = new MiniElement("html", this);
    this.head = this.documentElement.appendChild(new MiniElement("head", this));
    this.body = this.documentElement.appendChild(new MiniElement("body", this));
  }

  /** Just the singletons libraries ask for (react-remove-scroll injects its
   *  style tag into `getElementsByTagName("head")[0]`). */
  getElementsByTagName(tagName: string): MiniElement[] {
    const upper = tagName.toUpperCase();
    if (upper === "HEAD") return [this.head];
    if (upper === "BODY") return [this.body];
    if (upper === "HTML") return [this.documentElement];
    return [];
  }

  createElement(tagName: string): MiniElement {
    return new MiniElement(tagName, this);
  }

  /** Minimal element-only TreeWalker (Radix FocusScope enumerates focusable
   *  candidates with it; our elements are never focusable, which is fine). */
  createTreeWalker(
    root: MiniNode,
    _whatToShow?: number,
    filter?: { acceptNode?: (node: MiniNode) => number } | null,
  ): { currentNode: MiniNode; nextNode(): MiniNode | null } {
    const elements: MiniNode[] = [];
    const collect = (node: MiniNode): void => {
      for (const child of node.childNodes) {
        if (typeof (child as { tagName?: unknown }).tagName === "string") elements.push(child);
        collect(child);
      }
    };
    collect(root);
    let index = -1;
    return {
      currentNode: root,
      nextNode(): MiniNode | null {
        while (++index < elements.length) {
          const candidate = elements[index];
          const verdict = filter?.acceptNode ? filter.acceptNode(candidate) : 1;
          if (verdict === 1) {
            this.currentNode = candidate;
            return candidate;
          }
        }
        return null;
      },
    };
  }

  getElementById(id: string): MiniElement | null {
    const walk = (node: MiniNode): MiniElement | null => {
      for (const child of node.childNodes) {
        const el = child as MiniElement;
        if (typeof el.getAttribute === "function" && el.getAttribute("id") === id) return el;
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    return walk(this.body) ?? walk(this.documentElement);
  }

  // Same safe-empty selector answers as MiniElement (Radix focus-guards scans
  // `document.querySelectorAll("[data-radix-focus-guard]")` on dialog mount).
  querySelectorAll(_selector: string): MiniElement[] {
    return [];
  }

  querySelector(_selector: string): MiniElement | null {
    return null;
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
  win.HTMLInputElement = MiniElement;
  win.HTMLSelectElement = MiniElement;
  win.HTMLIFrameElement = class {};
  win.DocumentFragment = MiniDocumentFragment;
  win.SVGElement = MiniElement;
  win.setTimeout = globalThis.setTimeout.bind(globalThis);
  win.clearTimeout = globalThis.clearTimeout.bind(globalThis);
  doc.defaultView = win;

  // Layout/animation shims Radix primitives probe on mount (Presence reads
  // computed animation fields; useSize observes the control). Defined here so
  // no test file has to inject partial stubs that leak between files.
  const computedStyleStub = () => ({
    animationName: "none",
    animationDuration: "0s",
    transitionDuration: "0s",
    display: "block",
    getPropertyValue: () => "",
  });
  class MiniResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  class MiniMutationObserver {
    observe() {}
    disconnect() {}
    takeRecords(): unknown[] {
      return [];
    }
  }
  const nodeFilterConstants = {
    SHOW_ELEMENT: 0x1,
    SHOW_ALL: 0xffffffff,
    FILTER_ACCEPT: 1,
    FILTER_REJECT: 2,
    FILTER_SKIP: 3,
  };
  win.getComputedStyle = computedStyleStub;
  win.ResizeObserver = MiniResizeObserver;
  win.MutationObserver = MiniMutationObserver;
  win.NodeFilter = nodeFilterConstants;

  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    window: win,
    document: doc,
    Event: MiniEvent,
    CustomEvent: MiniEvent,
    Node: MiniNode,
    Element: MiniElement,
    HTMLElement: MiniElement,
    HTMLInputElement: MiniElement,
    HTMLSelectElement: MiniElement,
    DocumentFragment: MiniDocumentFragment,
    SVGElement: MiniElement,
    getComputedStyle: computedStyleStub,
    ResizeObserver: MiniResizeObserver,
    MutationObserver: MiniMutationObserver,
    NodeFilter: nodeFilterConstants,
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
