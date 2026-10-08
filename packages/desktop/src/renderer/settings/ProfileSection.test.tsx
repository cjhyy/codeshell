import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { DialogProvider } from "../ui/DialogProvider";
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
  test.each([false, true])(
    "unavailable default recovery is reachable with a valid candidate present=%s",
    async (hasCandidate) => {
      ensureMiniDom();
      const previews: Array<string | null> = [];
      let adopted = 0;
      Object.assign(window, {
        codeshell: {
          listProfiles: async () =>
            hasCandidate
              ? [{ name: "next", label: "Next", active: false, portableMemory: false }]
              : [],
          previewProfileSwitch: async (_target: unknown, name: string | null) => {
            previews.push(name);
            return {
              revision: "a".repeat(64),
              target: { kind: "project", projectId: "project-repo" },
              before: { name: "broken", label: "broken", available: false },
              after: null,
              instruction: { changed: null, beforeLength: null, afterLength: 0 },
              memory: { before: null, after: null },
              capabilities: [],
              missingDeclarations: [],
              sources: { before: [], after: [] },
              exclusiveSkillsOnly: false,
            };
          },
          adoptProfileSwitch: async () => {
            adopted++;
            return { status: "adopted" };
          },
        },
      });
      const container = document.createElement("div") as unknown as HTMLElement;
      root = createRoot(container);
      await act(async () => {
        root?.render(
          <DialogProvider>
            <ProfileSection configurationTarget={{ projectId: "project-repo" }} />
          </DialogProvider>,
        );
        await flushMicrotasks();
        await flushMicrotasks();
      });
      expect(textOf(container)).toContain("broken");
      const recovery = findElements(container, "BUTTON").find(
        (button) => textOf(button) === "取消项目默认",
      );
      expect(recovery).toBeDefined();
      expect(previews).toEqual([null]);
      await act(async () => {
        reactPropsOf(recovery).onClick();
        await flushMicrotasks();
      });
      // Opening recovery always takes a fresh review; neither query adopts.
      expect(previews).toEqual([null, null]);
      expect(adopted).toBe(0);
    },
  );

  test("discards a previous target's delayed unavailable-default query", async () => {
    ensureMiniDom();
    let resolveOld!: (value: unknown) => void;
    const delayed = new Promise((resolve) => {
      resolveOld = resolve;
    });
    Object.assign(window, {
      codeshell: {
        listProfiles: async () => [],
        previewProfileSwitch: async (target: { projectId: string }) =>
          target.projectId === "old" ? delayed : { before: null },
      },
    });
    const container = document.createElement("div") as unknown as HTMLElement;
    root = createRoot(container);
    const render = async (projectId: string) =>
      act(async () => {
        root?.render(
          <DialogProvider>
            <ProfileSection configurationTarget={{ projectId }} />
          </DialogProvider>,
        );
        await flushMicrotasks();
        await flushMicrotasks();
      });
    await render("old");
    await render("new");
    await act(async () => {
      resolveOld({ before: { name: "old-private-identity", label: "Old", available: false } });
      await flushMicrotasks();
    });
    expect(textOf(container)).not.toContain("old-private-identity");
    expect(findElements(container, "BUTTON")).toHaveLength(0);
  });

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
      root?.render(
        <DialogProvider>
          <ProfileSection configurationTarget={{ projectId: "project-repo" }} />
        </DialogProvider>,
      );
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(findElements(container, "LI")).toHaveLength(2);
    const text = textOf(container);
    expect(text).toContain("Seedance");
    expect(text).toContain("UI 设计师");
    expect(text).toContain("项目默认");
    expect(text).toContain("取消项目默认");
  });

  test("requests an impact preview without automatically adopting or refreshing", async () => {
    ensureMiniDom();
    let activeName = "seedance";
    let listCalls = 0;
    const activations: Array<[{ projectId: string }, string]> = [];
    const previews: Array<[{ projectId: string }, string]> = [];
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
        previewProfileSwitch: async (target: { projectId: string }, name: string) => {
          previews.push([target, name]);
          return {
            revision: "a".repeat(64),
            target: { kind: "project", projectId: target.projectId },
            before: { name: "seedance", label: "Seedance", available: true },
            after: { name, label: "UI 设计师", available: true },
            instruction: { changed: true, beforeLength: 4, afterLength: 8 },
            memory: { before: null, after: null },
            capabilities: [],
            missingDeclarations: [],
            sources: { before: [], after: [] },
            exclusiveSkillsOnly: false,
          };
        },
        adoptProfileSwitch: async (
          target: { projectId: string },
          name: string,
          revision: string,
        ) => {
          expect(revision).toBe("a".repeat(64));
          activations.push([target, name]);
          activeName = name;
          return { status: "adopted" };
        },
        previewProfileRequirements: async () => ({
          needsInstall: false,
          willRun: [],
          warnings: [],
          blockers: [],
        }),
        deactivateProfile: async () => undefined,
      },
    });

    const container = document.createElement("div") as unknown as HTMLElement;
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <DialogProvider>
          <ProfileSection configurationTarget={{ projectId: "project-repo" }} />
        </DialogProvider>,
      );
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const activateButton = findElements(container, "BUTTON").find(
      (button) => textOf(button) === "设为项目默认",
    );
    expect(activateButton).toBeDefined();
    await act(async () => {
      reactPropsOf(activateButton).onClick();
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(activations).toEqual([]);
    expect(previews).toEqual([[{ projectId: "project-repo" }, "ui-designer"]]);
    expect(listCalls).toBe(1);
  });
});
