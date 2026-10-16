import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { ModelPill, type ModelOption } from "./ModelPill";
import { groupModelOptions } from "./modelPickerPresentation";

describe("model picker presentation groups", () => {
  test("keeps first-seen provider order and each provider's original model objects", () => {
    const options = Object.freeze(
      [
        { key: "a-one", label: "Shared name", provider: "Provider A" },
        { key: "b-one", label: "Shared name", provider: "Provider B" },
        { key: "a-two", label: "Second A", provider: "Provider A" },
        { key: "c-one", label: "Only C", provider: "Provider C" },
        { key: "b-two", label: "Second B", provider: "Provider B" },
      ].map((option) => Object.freeze(option)),
    );
    const groups = groupModelOptions(options);
    expect(groups.map((group) => group.provider)).toEqual([
      "Provider A",
      "Provider B",
      "Provider C",
    ]);
    expect(groups.map((group) => group.options.map((option) => option.key))).toEqual([
      ["a-one", "a-two"],
      ["b-one", "b-two"],
      ["c-one"],
    ]);
    const displayed = groups.flatMap((group) => group.options);
    [0, 2, 1, 4, 3].forEach((sourceIndex, displayedIndex) =>
      expect(displayed[displayedIndex]).toBe(options[sourceIndex]),
    );
    expect(displayed.filter((option) => option.label === "Shared name")).toHaveLength(2);
    expect(options.map((option) => option.key)).toEqual([
      "a-one",
      "b-one",
      "a-two",
      "c-one",
      "b-two",
    ]);
  });

  test("retains exact provider labels and repeated entries without normalization or deduplication", () => {
    const repeated = Object.freeze({ provider: "__proto__", key: "same-object" });
    const options = Object.freeze([
      repeated,
      { provider: "constructor", key: "constructor" },
      { provider: "", key: "empty" },
      { provider: "Provider", key: "upper" },
      { provider: "provider", key: "lower" },
      repeated,
    ]);
    const groups = groupModelOptions(options);
    expect(groups.map((group) => group.provider)).toEqual([
      "__proto__",
      "constructor",
      "",
      "Provider",
      "provider",
    ]);
    expect(groups[0]!.options).toHaveLength(2);
    expect(groups[0]!.options[0]).toBe(repeated);
    expect(groups[0]!.options[1]).toBe(repeated);
    expect(groups.flatMap((group) => group.options)).toHaveLength(options.length);
  });

  test("returns an empty directory for an empty readonly catalog", () => {
    expect(groupModelOptions(Object.freeze([]))).toEqual([]);
  });
});

function descendants(node: Element): Element[] {
  return [node, ...Array.from(node.children).flatMap(descendants)];
}

function props(node: Element): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? (node as unknown as Record<string, any>)[key] : {};
}

describe("model picker grouped keyboard navigation", () => {
  let root: Root;
  let container: HTMLElement;
  let storageBefore: PropertyDescriptor | undefined;
  let elementPrototype: object;
  const windowBefore = new Map<string, PropertyDescriptor | undefined>();
  const layoutBefore = new Map<string, PropertyDescriptor | undefined>();
  const options: ModelOption[] = [
    { key: "a-one", label: "Shared name", provider: "Provider A", supportsVision: true },
    { key: "b-one", label: "Shared name", provider: "Provider B" },
    { key: "a-two", label: "Second A", provider: "Provider A" },
    { key: "b-two", label: "Second B", provider: "Provider B" },
  ];
  const selected: ModelOption[] = [];

  beforeEach(() => {
    ensureMiniDom();
    storageBefore = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: () => null, setItem: () => undefined },
    });
    for (const [key, value] of Object.entries({
      requestAnimationFrame: () => 0,
      cancelAnimationFrame: () => undefined,
      innerWidth: 1_024,
      innerHeight: 800,
    })) {
      windowBefore.set(key, Object.getOwnPropertyDescriptor(window, key));
      Object.defineProperty(window, key, { configurable: true, value });
    }
    container = document.createElement("div");
    elementPrototype = Object.getPrototypeOf(container);
    for (const [key, value] of Object.entries({ offsetWidth: 288, offsetHeight: 160 })) {
      layoutBefore.set(key, Object.getOwnPropertyDescriptor(elementPrototype, key));
      Object.defineProperty(elementPrototype, key, { configurable: true, value });
    }
    document.body.appendChild(container);
    root = createRoot(container);
    selected.length = 0;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
    document.body.removeChild(container);
    if (storageBefore) Object.defineProperty(globalThis, "localStorage", storageBefore);
    else Reflect.deleteProperty(globalThis, "localStorage");
    for (const [key, descriptor] of windowBefore) {
      if (descriptor) Object.defineProperty(window, key, descriptor);
      else Reflect.deleteProperty(window, key);
    }
    windowBefore.clear();
    for (const [key, descriptor] of layoutBefore) {
      if (descriptor) Object.defineProperty(elementPrototype, key, descriptor);
      else Reflect.deleteProperty(elementPrototype, key);
    }
    layoutBefore.clear();
  });

  const render = async (activeKey: string | null) => {
    await act(async () => {
      root.render(
        <ModelPill
          activeKey={activeKey}
          options={options}
          onSelect={(option) => selected.push(option)}
          portal={false}
        />,
      );
      await flushMicrotasks();
    });
  };
  const menu = () => descendants(container).find((node) => props(node).role === "listbox")!;
  const optionNodes = () => descendants(menu()).filter((node) => props(node).role === "option");
  const click = async (node: Element) => {
    await act(async () => {
      props(node).onClick();
      await flushMicrotasks();
    });
  };
  const open = async () => {
    const trigger = descendants(container).find(
      (node) => props(node)["aria-haspopup"] === "listbox",
    )!;
    Object.assign(trigger, {
      getBoundingClientRect: () => ({ top: 400, bottom: 432, left: 40, right: 160 }),
    });
    (trigger as HTMLElement).focus();
    await click(trigger);
  };
  const focused = () => props(document.activeElement)["data-model-key"];
  const press = async (key: string) => {
    await act(async () => {
      props(menu()).onKeyDown({
        key,
        nativeEvent: { isComposing: false },
        keyCode: 0,
        preventDefault() {},
        stopPropagation() {},
      });
      await flushMicrotasks();
    });
  };

  test("Arrow and Home/End follow grouped display order for an interleaved catalog", async () => {
    await render("a-one");
    await open();
    expect(
      descendants(menu())
        .filter((node) => props(node).role === "group")
        .map((node) => props(node)["data-model-provider"]),
    ).toEqual(["Provider A", "Provider B"]);
    expect(optionNodes().map((node) => props(node)["data-model-key"])).toEqual([
      "a-one",
      "a-two",
      "b-one",
      "b-two",
    ]);
    expect(focused()).toBe("a-one");
    for (const key of ["a-two", "b-one", "b-two"]) {
      await press("ArrowDown");
      expect(focused()).toBe(key);
    }
    await press("ArrowDown");
    expect(focused()).toBe("b-two");
    await press("Home");
    expect(focused()).toBe("a-one");
    await press("End");
    expect(focused()).toBe("b-two");
    await press("ArrowUp");
    expect(focused()).toBe("b-one");
    expect(selected).toHaveLength(0);
  });

  test("equal model labels retain distinct selected keys and select the exact source object", async () => {
    await render("b-one");
    await open();
    expect(focused()).toBe("b-one");
    expect(
      optionNodes()
        .filter((node) => props(node)["aria-selected"])
        .map((node) => props(node)["data-model-key"]),
    ).toEqual(["b-one"]);
    const first = optionNodes().find((node) => props(node)["data-model-key"] === "a-one")!;
    expect(descendants(first).some((node) => props(node)["aria-label"] === "支持图片输入")).toBe(
      true,
    );
    await click(first);
    expect(selected).toHaveLength(1);
    expect(selected[0]).toBe(options[0]);
    expect(selected[0]).not.toBe(options[1]);
    expect(descendants(container).some((node) => props(node).role === "listbox")).toBe(false);
  });
});
