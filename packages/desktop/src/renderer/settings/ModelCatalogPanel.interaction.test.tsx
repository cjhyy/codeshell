import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CatalogEntry } from "../../preload/types";
import { ModelCatalogPanel } from "./ModelCatalogPanel";
import { blankCatalogEntry } from "./catalogEditor";
import { ToastProvider } from "../ui/ToastProvider";
import { DialogProvider } from "../ui/DialogProvider";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

function descendants(node: any): any[] {
  return [node, ...Array.from(node.childNodes ?? []).flatMap(descendants)];
}
function textOf(node: any): string {
  if (node.nodeType === 3) return node.data ?? "";
  const children = Array.from(node.childNodes ?? []);
  return children.length ? children.map(textOf).join("") : (node.textContent ?? "");
}
function props(node: any): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? node[key] : {};
}

describe("model catalog option editing", () => {
  let root: Root;
  let container: HTMLElement;
  let apiBefore: PropertyDescriptor | undefined;
  let storageBefore: PropertyDescriptor | undefined;
  let entry: CatalogEntry;
  let saved: CatalogEntry[];

  beforeEach(() => {
    ensureMiniDom();
    apiBefore = Object.getOwnPropertyDescriptor(window, "codeshell");
    storageBefore = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: () => null, setItem: () => undefined },
    });
    entry = {
      ...blankCatalogEntry("text"),
      id: "catalog-test",
      displayName: "Catalog Test",
      defaultBaseUrl: "https://example.invalid/v1",
      modelPresets: [
        {
          value: "test-model",
          params: [
            { name: "reasoning", control: "enum", options: [] },
            { name: "style", control: "enum", options: ["brief", "detailed"] },
          ],
        },
      ],
    };
    saved = [];
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      value: {
        getModelCatalog: async () => [structuredClone(entry)],
        getCatalogOrigins: async () => ({ "catalog-test": "user" }),
        saveCatalogEntry: async (next: CatalogEntry) => {
          saved.push(structuredClone(next));
          entry = structuredClone(next);
          return { ok: true };
        },
      },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
    document.body.removeChild(container);
    if (apiBefore) Object.defineProperty(window, "codeshell", apiBefore);
    else Reflect.deleteProperty(window, "codeshell");
    if (storageBefore) Object.defineProperty(globalThis, "localStorage", storageBefore);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });

  const nodes = () => descendants(container);
  const buttons = (text: string) =>
    nodes().filter((node) => node.tagName === "BUTTON" && textOf(node) === text);
  const inputs = (label: string) =>
    nodes()
      .filter((node) => node.tagName === "LABEL" && textOf(node) === label)
      .map((node) => descendants(node).find((child) => child.tagName === "INPUT"));
  const click = async (node: any) => {
    await act(async () => {
      props(node).onClick();
      await flushMicrotasks();
    });
  };
  const change = async (node: any, value: string) => {
    await act(async () => {
      props(node).onChange({ target: { value } });
      await flushMicrotasks();
    });
  };
  const openEditor = async () => {
    await act(async () => {
      root.render(
        <ToastProvider>
          <DialogProvider>
            <ModelCatalogPanel scope="user" activeProjectPath={null} />
          </DialogProvider>
        </ToastProvider>,
      );
      await flushMicrotasks();
    });
    await click(
      nodes().find((node) => node.tagName === "BUTTON" && textOf(node).startsWith("Catalog Test")),
    );
    await click(buttons("编辑")[0]);
  };

  test("accepts typed commas and spaces while saving normalized option values", async () => {
    await openEditor();
    const input = inputs("选项（逗号分隔）")[0];
    input.focus();
    let typed = "";
    for (const char of "low, high,, ") {
      typed += char;
      await change(input, typed);
      expect(props(input).value).toBe(typed);
      expect(document.activeElement).toBe(input);
    }
    await click(buttons("保存")[0]);
    expect(saved).toHaveLength(1);
    expect(saved[0].modelPresets?.[0].params?.[0].options).toEqual(["low", "high"]);
  });

  test("keeps incomplete text through other field edits and discards it when cancelled", async () => {
    await openEditor();
    const input = inputs("选项（逗号分隔）")[0];
    await change(input, "low, ");
    await change(inputs("模型 ID")[0], "renamed-model");
    expect(props(input).value).toBe("low, ");
    await act(async () => {
      props(input).onBlur();
      await flushMicrotasks();
    });
    expect(props(input).value).toBe("low");
    await click(buttons("取消")[0]);
    await click(
      nodes().find((node) => node.tagName === "BUTTON" && textOf(node).startsWith("Catalog Test")),
    );
    await click(buttons("编辑")[0]);
    expect(props(inputs("选项（逗号分隔）")[0]).value).toBe("");
    expect(saved).toHaveLength(0);
  });

  test("removing an earlier parameter does not move its draft into the next parameter", async () => {
    await openEditor();
    await change(inputs("选项（逗号分隔）")[0], "unfinished,");
    await click(buttons("删除")[0]);
    expect(inputs("选项（逗号分隔）")).toHaveLength(1);
    expect(props(inputs("选项（逗号分隔）")[0]).value).toBe("brief,detailed");
    await click(buttons("保存")[0]);
    expect(saved[0].modelPresets?.[0].params).toEqual([
      { name: "style", control: "enum", options: ["brief", "detailed"] },
    ]);
  });
});
