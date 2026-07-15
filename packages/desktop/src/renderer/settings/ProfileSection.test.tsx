import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { ProfileSection } from "./ProfileSection";

function reactPropsOf(node: unknown): Record<string, any> {
  const current = node as Record<string, any>;
  const key = Object.keys(current).find((name) => name.startsWith("__reactProps$"));
  return key ? current[key] : {};
}

function findElements(node: unknown, tagName: string): any[] {
  const current = node as { tagName?: string; childNodes?: unknown[] };
  return [
    ...(current.tagName === tagName ? [current] : []),
    ...(current.childNodes ?? []).flatMap((child) => findElements(child, tagName)),
  ];
}

function textOf(node: unknown): string {
  const current = node as {
    nodeType?: number;
    data?: string;
    childNodes?: unknown[];
    textContent?: string;
  };
  if (current.nodeType === 3) return current.data ?? current.textContent ?? "";
  const children = Array.from(current.childNodes ?? []);
  if (children.length === 0) return current.textContent ?? "";
  return children.map((child) => textOf(child)).join("");
}

let root: Root | null = null;

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
      await flushMicrotasks();
    });
  }
  root = null;
});

describe("ProfileSection", () => {
  test("renders two profiles and marks the active one", async () => {
    ensureMiniDom();
    Object.assign(window, {
      codeshell: {
        listProfiles: async () => [
          {
            name: "seedance",
            label: "Seedance",
            description: "分镜制片人",
            active: true,
            portableMemory: true,
          },
          {
            name: "ui-designer",
            label: "UI 设计师",
            description: undefined,
            active: false,
            portableMemory: false,
          },
        ],
        activateProfile: async () => undefined,
        deactivateProfile: async () => undefined,
      },
    });

    const container = document.createElement("div") as unknown as HTMLElement;
    root = createRoot(container);
    await act(async () => {
      root?.render(<ProfileSection cwd="/repo" />);
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(findElements(container, "LI")).toHaveLength(2);
    const text = textOf(container);
    expect(text).toContain("Seedance");
    expect(text).toContain("UI 设计师");
    expect(text).toContain("当前");
    expect(text).toContain("关闭");
  });

  test("activates an inactive profile and refreshes the list", async () => {
    ensureMiniDom();
    let activeName = "seedance";
    let listCalls = 0;
    const activations: Array<[string, string]> = [];
    Object.assign(window, {
      codeshell: {
        listProfiles: async () => {
          listCalls += 1;
          return [
            {
              name: "seedance",
              label: "Seedance",
              description: undefined,
              active: activeName === "seedance",
              portableMemory: false,
            },
            {
              name: "ui-designer",
              label: "UI 设计师",
              description: undefined,
              active: activeName === "ui-designer",
              portableMemory: false,
            },
          ];
        },
        activateProfile: async (cwd: string, name: string) => {
          activations.push([cwd, name]);
          activeName = name;
        },
        deactivateProfile: async () => undefined,
      },
    });

    const container = document.createElement("div") as unknown as HTMLElement;
    root = createRoot(container);
    await act(async () => {
      root?.render(<ProfileSection cwd="/repo" />);
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const activateButton = findElements(container, "BUTTON").find(
      (button) => textOf(button) === "激活",
    );
    expect(activateButton).toBeDefined();
    await act(async () => {
      reactPropsOf(activateButton).onClick();
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(activations).toEqual([["/repo", "ui-designer"]]);
    expect(listCalls).toBe(2);
  });
});
