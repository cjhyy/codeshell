import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CredentialsPage } from "./CredentialsPage";
import { credentialMatchesQuery } from "./CredentialSearch";
import type { MaskedCredentialView } from "./types";
import { DialogProvider } from "../ui/DialogProvider";
import { ToastProvider } from "../ui/ToastProvider";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

function propsOf(node: Element): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? (node as unknown as Record<string, any>)[key] : {};
}

function descendants(node: Element): Element[] {
  return [node, ...Array.from(node.children).flatMap(descendants)];
}

const FIXTURES: MaskedCredentialView[] = [
  {
    id: "work-cookie",
    type: "cookie",
    label: "Work account",
    hasSecret: true,
    secretHint: "masked-secret-marker",
    meta: { platform: "example", domain: "example.com" },
  },
  {
    id: "personal-cookie",
    type: "cookie",
    label: "Personal account",
    hasSecret: true,
    meta: { platform: "notes", domain: "notes.test" },
  },
  {
    id: "build-token",
    type: "token",
    label: "Build service",
    hasSecret: true,
    exposeAsEnv: "BUILD_API_TOKEN",
  },
  { id: "docs-token", type: "token", label: "Docs service", hasSecret: false },
];

describe("credential metadata search", () => {
  test("matches case-insensitive words across labels and metadata without searching secret hints", () => {
    expect(credentialMatchesQuery(FIXTURES[0], " WORK example.com ")).toBe(true);
    expect(credentialMatchesQuery(FIXTURES[0], "work missing")).toBe(false);
    expect(credentialMatchesQuery(FIXTURES[0], "masked-secret-marker")).toBe(false);
    expect(credentialMatchesQuery(FIXTURES[2], "build_api_token")).toBe(true);
    expect(credentialMatchesQuery(FIXTURES[2], "   ")).toBe(true);
  });
});

describe("CredentialsPage navigation and search", () => {
  let root: Root;
  let container: HTMLElement;
  let listCalls: number;
  let stored: Map<string, string>;
  let restore: Array<() => void>;
  const replace = (object: object, key: string, value: unknown) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    Object.defineProperty(object, key, { configurable: true, writable: true, value });
    restore.push(() => {
      if (descriptor) Object.defineProperty(object, key, descriptor);
      else Reflect.deleteProperty(object, key);
    });
  };

  beforeEach(() => {
    ensureMiniDom();
    restore = [];
    stored = new Map();
    listCalls = 0;
    replace(window, "localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    });
    replace(window, "codeshell", {
      credentials: {
        list: async () => {
          listCalls += 1;
          return FIXTURES;
        },
      },
    });
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
    for (const reset of restore.reverse()) reset();
  });

  const render = async () => {
    await act(async () => {
      root.render(
        <ToastProvider>
          <DialogProvider>
            <CredentialsPage activeProjectPath={null} />
          </DialogProvider>
        </ToastProvider>,
      );
      await flushMicrotasks();
    });
  };
  const tab = (key: string) =>
    descendants(container).find(
      (node) => propsOf(node).role === "tab" && propsOf(node).id.endsWith(`-tab-${key}`),
    )!;
  const articles = () =>
    descendants(container)
      .filter((node) => node.tagName === "ARTICLE")
      .map((node) => propsOf(node)["aria-label"]);
  const search = () => descendants(container).find((node) => propsOf(node).type === "search")!;
  const searchFor = async (value: string) => {
    await act(async () => {
      propsOf(search()).onChange({ target: { value } });
      await flushMicrotasks();
    });
  };

  test("arrow navigation moves focus without activating or loading a different category", async () => {
    await render();
    expect(listCalls).toBe(1);
    await act(async () => {
      propsOf(tab("cookie")).onKeyDown({ key: "ArrowRight", preventDefault() {} });
      await flushMicrotasks();
    });
    expect(document.activeElement).toBe(tab("token"));
    expect(propsOf(tab("cookie"))["aria-selected"]).toBe(true);
    expect(propsOf(tab("token"))["aria-selected"]).toBe(false);
    expect(propsOf(tab("token")).tabIndex).toBe(0);
    expect(listCalls).toBe(1);

    await act(async () => {
      // Enter/Space on a native button delivers its click; activation is explicit.
      propsOf(tab("token")).onClick();
      await flushMicrotasks();
    });
    expect(propsOf(tab("token"))["aria-selected"]).toBe(true);
    expect(listCalls).toBe(2);
    expect(stored.get("codeshell:credentials:last-tab")).toBe("token");
    const panel = descendants(container).find((node) => propsOf(node).role === "tabpanel")!;
    expect(propsOf(panel)["aria-labelledby"]).toBe(propsOf(tab("token")).id);
    expect(propsOf(tab("token"))["aria-controls"]).toBe(propsOf(panel).id);
  });

  test("filters Cookie accounts locally and clears an empty result back to the search field", async () => {
    await render();
    expect(articles()).toEqual(["Work account", "Personal account"]);
    await searchFor("EXAMPLE.COM work");
    expect(articles()).toEqual(["Work account"]);
    expect(listCalls).toBe(1);
    await searchFor("no matching account");
    expect(articles()).toEqual([]);
    const clear = descendants(container).find(
      (node) => propsOf(node)["aria-label"] === "清空搜索",
    )!;
    await act(async () => {
      propsOf(clear).onClick();
      await flushMicrotasks();
    });
    expect(propsOf(search()).value).toBe("");
    expect(document.activeElement).toBe(search());
    expect(articles()).toEqual(["Work account", "Personal account"]);
    expect(listCalls).toBe(1);
  });

  test("restores the saved Token category and finds a token by its environment variable", async () => {
    stored.set("codeshell:credentials:last-tab", "token");
    await render();
    expect(propsOf(tab("token"))["aria-selected"]).toBe(true);
    expect(articles()).toEqual(["Build service", "Docs service"]);
    await searchFor("BUILD_API_TOKEN");
    expect(articles()).toEqual(["Build service"]);
    expect(listCalls).toBe(1);
  });
});
